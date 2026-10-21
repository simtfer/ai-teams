import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { Logger } from "../src/shared/logger.js";
import type { TaskStatus } from "../src/shared/types.js";
import { loadSupervisorConfig } from "../src/supervisor/config.js";
import { SupervisorStore } from "../src/supervisor/db.js";
import { SupervisorService } from "../src/supervisor/service.js";
import {
  createWorkdir,
  makeTempRoot,
  startTestNode,
  waitFor,
  writeSupervisorConfig,
  type TestNode,
} from "./helpers.js";

const TERMINAL: TaskStatus[] = [
  "succeeded",
  "failed",
  "needs_input",
  "interrupted",
  "canceled",
];

let node: TestNode;
let tempRoot: string;
let store: SupervisorStore;
let service: SupervisorService;

before(async () => {
  node = await startTestNode({ nodeId: "node-supervisor" });
  tempRoot = makeTempRoot("ai-teams-supervisor-");
  const configPath = writeSupervisorConfig(tempRoot, [
    {
      id: node.nodeId,
      name: "Test node",
      baseUrl: node.baseUrl,
      token: node.token,
    },
  ]);
  const loaded = loadSupervisorConfig(configPath);
  store = new SupervisorStore(loaded.dbPath);
  service = new SupervisorService(loaded, store, new Logger("test-supervisor"));
});

after(async () => {
  store.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  await node.close();
});

test("supervisor lists online nodes and creates employees", async () => {
  const nodes = await service.listNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].online, true);
  assert.equal(nodes[0].version, "0.1.0");

  const cwd = createWorkdir(node.workspace, "supervisor-alice");
  const created = await service.createEmployee({
    nodeId: node.nodeId,
    name: "Supervisor Alice",
    cwd,
  });
  assert.match(created.employee.id, /^emp-/);
  assert.equal(created.employee.cwd, fs.realpathSync.native(cwd));
  assert.equal(created.node.online, true);

  const employees = await service.listEmployees();
  assert.ok(employees.employees.some((employee) => employee.id === created.employee.id));
});

test("assign_task stores results without exposing them until get_task_result", async () => {
  const employees = await service.listEmployees();
  const employee = employees.employees.find((candidate) => candidate.name === "Supervisor Alice");
  assert.ok(employee);

  const assigned = await service.assignTask({
    employeeId: employee.id,
    nodeId: node.nodeId,
    prompt: "MODE:echo SUPERVISOR-OK",
    source: "user",
  });
  assert.equal(assigned.task.source, "user");

  const done = await waitFor(
    async () => {
      const detail = await service.getTask(assigned.task.id);
      return TERMINAL.includes(detail.task.status) ? detail : null;
    },
    20_000,
    "supervisor task to finish",
  );
  assert.equal(done.task.status, "succeeded");
  assert.equal(done.task.hasResult, true);
  assert.equal("resultText" in done.task, false);

  const pending = await service.listPendingResults();
  assert.ok(pending.pending.some((result) => result.taskId === assigned.task.id));

  const result = await service.getTaskResult(assigned.task.id);
  assert.equal(result.available, true);
  assert.equal(result.alreadyFetched, false);
  assert.match(result.resultText ?? "", /ECHO:.*SUPERVISOR-OK/);

  const pendingAfter = await service.listPendingResults();
  assert.equal(
    pendingAfter.pending.some((item) => item.taskId === assigned.task.id),
    false,
  );

  const again = await service.getTaskResult(assigned.task.id);
  assert.equal(again.alreadyFetched, true);
  assert.equal(again.resultText, result.resultText);
});

test("supervisor can cancel a running task", async () => {
  const cwd = createWorkdir(node.workspace, "supervisor-grace");
  const created = await service.createEmployee({
    nodeId: node.nodeId,
    name: "Supervisor Grace",
    cwd,
  });
  const assigned = await service.assignTask({
    employeeId: created.employee.id,
    nodeId: node.nodeId,
    prompt: "MODE:slow",
    source: "supervisor",
  });

  await waitFor(
    async () => {
      const detail = await service.getTask(assigned.task.id);
      return detail.task.status === "running" ? detail : null;
    },
    10_000,
    "task to start running",
  );

  const canceled = await service.cancelTask(assigned.task.id);
  assert.equal(canceled.task.status, "canceled");

  const detail = await service.getTask(assigned.task.id);
  assert.equal(detail.task.status, "canceled");

  const canceledResult = await service.getTaskResult(assigned.task.id);
  assert.equal(canceledResult.available, true);
  assert.match(canceledResult.resultText ?? "", /No employee result text/);
  assert.match(canceledResult.resultText ?? "", /Status: canceled/);
});

test("terminal tasks without result text return an error report and clear pending", async () => {
  const cwd = createWorkdir(node.workspace, "supervisor-failure");
  const created = await service.createEmployee({
    nodeId: node.nodeId,
    name: "Supervisor Failure",
    cwd,
  });
  const assigned = await service.assignTask({
    employeeId: created.employee.id,
    nodeId: node.nodeId,
    prompt: "MODE:fail",
    source: "supervisor",
  });

  const done = await waitFor(
    async () => {
      const detail = await service.getTask(assigned.task.id);
      return TERMINAL.includes(detail.task.status) ? detail : null;
    },
    20_000,
    "failure task to finish",
  );
  assert.equal(done.task.status, "failed");

  const pending = await service.listPendingResults();
  assert.ok(pending.pending.some((item) => item.taskId === assigned.task.id));

  const result = await service.getTaskResult(assigned.task.id);
  assert.equal(result.available, true);
  assert.match(result.resultText ?? "", /No employee result text/);
  assert.match(result.resultText ?? "", /Status: failed/);

  const pendingAfter = await service.listPendingResults();
  assert.equal(
    pendingAfter.pending.some((item) => item.taskId === assigned.task.id),
    false,
  );
});

test("offline nodes fall back to cached employees, tasks, and full results", async () => {
  const employees = await service.listEmployees();
  const employee = employees.employees.find((candidate) => candidate.name === "Supervisor Alice");
  assert.ok(employee);

  const assigned = await service.assignTask({
    employeeId: employee.id,
    nodeId: node.nodeId,
    prompt: "MODE:long",
    source: "supervisor",
  });
  await waitFor(
    async () => {
      const detail = await service.getTask(assigned.task.id);
      return TERMINAL.includes(detail.task.status) ? detail : null;
    },
    20_000,
    "offline test task to finish",
  );

  await node.stopHttp();

  const nodes = await service.listNodes();
  assert.equal(nodes[0].online, false);

  const cachedEmployees = await service.listEmployees();
  assert.ok(cachedEmployees.employees.some((item) => item.id === employee.id));

  const cachedTask = await service.getTask(assigned.task.id);
  assert.equal(cachedTask.task.status, "succeeded");
  assert.equal(cachedTask.node.online, false);
  assert.equal(cachedTask.task.hasResult, true);

  const result = await service.getTaskResult(assigned.task.id);
  assert.equal(result.available, true);
  assert.ok((result.resultText ?? "").length > 120_000);
  assert.equal(result.node.online, false);
});
