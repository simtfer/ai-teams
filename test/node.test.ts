import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NodeStore } from "../src/node/db.js";
import { pathKey } from "../src/shared/paths.js";
import type {
  ApiErrorBody,
  Employee,
  NodeHealth,
  Task,
  TaskEvent,
  TaskResultResponse,
} from "../src/shared/types.js";
import {
  api,
  createEmployee,
  createTask,
  createWorkdir,
  isProcessAlive,
  readFakeRuns,
  readGrandchildPid,
  startTestNode,
  waitFor,
  waitForTaskStatus,
  type TestNode,
} from "./helpers.js";

let node: TestNode;

before(async () => {
  node = await startTestNode();
});

after(async () => {
  await node.close();
});

test("node health requires a bearer token", async () => {
  const unauthorized = await fetch(`${node.baseUrl}/health`);
  assert.equal(unauthorized.status, 401);

  const health = await api<NodeHealth>(node, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.nodeId, node.nodeId);
  assert.ok(health.data.harnesses.some((harness) => harness.type === "pi"));
  assert.equal(health.data.harnesses[0].actualVersion, "1.3.0");
  assert.equal(health.data.harnesses[0].versionMatches, true);
});

test("employee creation enforces allowed roots and unique working directories", async () => {
  const alice = await createEmployee(node, "Alice", "alice");

  const duplicateCwd = await api<ApiErrorBody>(node, "POST", "/api/employees", {
    id: `emp-${crypto.randomUUID()}`,
    name: "Alice duplicate",
    harness: "pi",
    cwd: alice.cwd,
  });
  assert.equal(duplicateCwd.status, 409);
  assert.equal(duplicateCwd.data.error.code, "CWD_IN_USE");

  const missing = await api<ApiErrorBody>(node, "POST", "/api/employees", {
    id: `emp-${crypto.randomUUID()}`,
    name: "Missing cwd",
    harness: "pi",
    cwd: path.join(node.workspace, "does-not-exist"),
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error.code, "DIRECTORY_NOT_FOUND");

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-outside-"));
  try {
    const outside = await api<ApiErrorBody>(node, "POST", "/api/employees", {
      id: `emp-${crypto.randomUUID()}`,
      name: "Outside",
      harness: "pi",
      cwd: outsideDir,
    });
    assert.equal(outside.status, 400);
    assert.equal(outside.data.error.code, "CWD_OUTSIDE_ALLOWED_ROOTS");
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }

  const employee = await api<Employee>(node, "GET", `/api/employees/${alice.id}`);
  assert.equal(employee.status, 200);
  assert.equal(employee.data.name, "Alice");
  assert.ok(employee.data.sessionId);
});

test("employee session is reused across tasks and results are persisted with ordered events", async () => {
  const bob = await createEmployee(node, "Bob", "bob");
  const employee = await api<Employee>(node, "GET", `/api/employees/${bob.id}`);
  assert.equal(employee.status, 200);

  const first = await createTask(node, bob.id, "MODE:remember:ALPHA");
  const firstDone = await waitForTaskStatus(node, first.id, ["succeeded"]);
  assert.equal(firstDone.resultText, "STORED:ALPHA");

  const second = await createTask(node, bob.id, "MODE:recall");
  const secondDone = await waitForTaskStatus(node, second.id, ["succeeded"]);
  assert.match(secondDone.resultText ?? "", /MODE:remember:ALPHA/);

  const runs = readFakeRuns(node.fakeStateDir).filter((run) => run.cwd === bob.cwd);
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map((run) => run.sessionId)).size, 1);
  assert.equal(runs[0].sessionId, employee.data.sessionId);

  const events = await api<TaskEvent[]>(node, "GET", "/api/events?unacked=true&limit=500");
  assert.equal(events.status, 200);
  const taskEvents = events.data.filter(
    (event) => event.taskId === first.id || event.taskId === second.id,
  );
  assert.equal(taskEvents.length, 2);
  assert.ok(taskEvents[0].seq < taskEvents[1].seq);
  assert.equal(taskEvents[0].type, "task.succeeded");
  assert.equal(taskEvents[0].resultText, "STORED:ALPHA");

  const ack = await api<{ acked: number }>(node, "POST", "/api/events/ack", {
    seqs: [taskEvents[0].seq],
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.data.acked, 1);

  const remaining = await api<TaskEvent[]>(node, "GET", "/api/events?unacked=true&limit=500");
  assert.equal(
    remaining.data.some((event) => event.taskId === first.id),
    false,
  );

  const result = await api<TaskResultResponse>(node, "GET", `/api/tasks/${first.id}/result`);
  assert.equal(result.status, 200);
  assert.equal(result.data.eventSeq, taskEvents[0].seq);
  assert.equal(result.data.task.resultText, "STORED:ALPHA");
});

test("large employee results are stored without truncation", async () => {
  const carol = await createEmployee(node, "Carol", "carol");
  const task = await createTask(node, carol.id, "MODE:long");
  const done = await waitForTaskStatus(node, task.id, ["succeeded"]);
  assert.ok(done.resultText);
  assert.ok(done.resultText.length > 120_000);
  assert.ok(done.resultText.startsWith("LONG:"));
});

test("needs_input results are detected and reported", async () => {
  const dave = await createEmployee(node, "Dave", "dave");
  const task = await createTask(node, dave.id, "MODE:needs_input");
  const done = await waitForTaskStatus(node, task.id, ["needs_input"]);
  assert.match(done.resultText ?? "", /^NEEDS_INPUT:/);

  const events = await api<TaskEvent[]>(node, "GET", "/api/events?unacked=true&limit=500");
  const event = events.data.find((candidate) => candidate.taskId === task.id);
  assert.equal(event?.type, "task.needs_input");
});

test("failed tasks are reported once and are not retried automatically", async () => {
  const erin = await createEmployee(node, "Erin", "erin");
  const task = await createTask(node, erin.id, "MODE:fail");
  const failed = await waitForTaskStatus(node, task.id, ["failed"]);
  assert.match(failed.error ?? "", /fake pi exploded/);
  assert.match(failed.error ?? "", /code 2/);

  const tasks = await api<Task[]>(node, "GET", `/api/tasks?employeeId=${erin.id}`);
  assert.equal(tasks.data.length, 1);
  assert.equal(tasks.data[0].status, "failed");
});

test("per-task timeout fails the task", async () => {
  const frank = await createEmployee(node, "Frank", "frank");
  const task = await createTask(node, frank.id, "MODE:slow", { timeoutMs: 400 });
  const failed = await waitForTaskStatus(node, task.id, ["failed"], 10_000);
  assert.match(failed.error ?? "", /timed out after 400 ms/);
});

test("cancel terminates a running task and the queued task starts", async () => {
  const grace = await createEmployee(node, "Grace", "grace");
  const slow = await createTask(node, grace.id, "MODE:slow");
  await waitForTaskStatus(node, slow.id, ["running"]);
  const grandchildPid = await waitFor(
    async () => readGrandchildPid(node.fakeStateDir),
    10_000,
    "slow fake pi to spawn its child",
  );

  const next = await createTask(node, grace.id, "MODE:echo CANCELLED-TEST");
  const cancel = await api<Task>(node, "POST", `/api/tasks/${slow.id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.status, "canceled");

  const nextDone = await waitForTaskStatus(node, next.id, ["succeeded"], 20_000);
  assert.match(nextDone.resultText ?? "", /ECHO:.*CANCELLED-TEST/);

  await waitFor(
    async () => (isProcessAlive(grandchildPid) ? null : true),
    10_000,
    "canceled pi process tree to be killed",
  );

  const events = await api<TaskEvent[]>(node, "GET", "/api/events?unacked=true&limit=500");
  const canceled = events.data.find((event) => event.taskId === slow.id);
  assert.equal(canceled?.type, "task.canceled");
});

test("disabled employees reject new tasks", async () => {
  const heidi = await createEmployee(node, "Heidi", "heidi");
  const disable = await api<Employee>(node, "POST", `/api/employees/${heidi.id}/disable`);
  assert.equal(disable.status, 200);
  assert.equal(disable.data.enabled, false);

  const task = await api<ApiErrorBody>(node, "POST", "/api/tasks", {
    id: `task-${crypto.randomUUID()}`,
    employeeId: heidi.id,
    prompt: "MODE:echo should not run",
    source: "user",
  });
  assert.equal(task.status, 409);
  assert.equal(task.data.error.code, "EMPLOYEE_DISABLED");
});

test("startup reconciliation marks orphaned running tasks as interrupted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-store-"));
  const workspace = createWorkdir(root, "workspace");
  const store = new NodeStore(path.join(root, "node.db"));
  const createdAt = new Date().toISOString();
  try {
    store.createEmployee({
      id: "emp-orphan",
      name: "Orphan",
      harness: "pi",
      cwd: workspace,
      cwdKey: pathKey(workspace),
      sessionId: crypto.randomUUID(),
      now: createdAt,
    });
    store.createTask({
      id: "task-orphan",
      employeeId: "emp-orphan",
      prompt: "MODE:slow",
      acceptanceCriteria: null,
      source: "user",
      timeoutMs: null,
      now: createdAt,
    });
    assert.equal(store.startTask("task-orphan", createdAt), true);

    const events = store.markRunningTasksInterrupted("node-orphan", new Date().toISOString());
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "task.interrupted");
    assert.equal(store.getTask("task-orphan")?.status, "interrupted");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("node shutdown interrupts running tasks and kills the harness process tree", async () => {
  const local = await startTestNode();
  try {
    const ivan = await createEmployee(local, "Ivan", "ivan");
    const task = await createTask(local, ivan.id, "MODE:slow");
    await waitForTaskStatus(local, task.id, ["running"]);
    const grandchildPid = await waitFor(
      async () => readGrandchildPid(local.fakeStateDir),
      10_000,
      "slow fake pi to spawn its child",
    );

    await local.service.shutdown();

    const stopped = await api<Task>(local, "GET", `/api/tasks/${task.id}`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.status, "interrupted");
    assert.match(stopped.data.error ?? "", /stopped while the task was running/);

    await waitFor(
      async () => (isProcessAlive(grandchildPid) ? null : true),
      10_000,
      "shutdown to kill the harness process tree",
    );
  } finally {
    await local.close();
  }
});
