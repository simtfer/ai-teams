import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Task, TaskEvent } from "../src/shared/types.js";
import {
  api,
  createWorkdir,
  makeTempRoot,
  projectRoot,
  startTestNode,
  waitFor,
  writeSupervisorConfig,
  type TestNode,
} from "./helpers.js";

let node: TestNode;
let tempRoot: string;
let client: Client;
let transport: StdioClientTransport;
let mcpStderr = "";

before(async () => {
  node = await startTestNode({ nodeId: "node-mcp" });
  tempRoot = makeTempRoot("ai-teams-mcp-");
  const configPath = writeSupervisorConfig(tempRoot, [
    {
      id: node.nodeId,
      name: "Test node",
      baseUrl: node.baseUrl,
      token: node.token,
    },
  ]);

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.AI_TEAMS_SUPERVISOR_CONFIG = configPath;
  env.LOG_LEVEL = "error";

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "src", "supervisor", "mcp.js"), "--config", configPath],
    cwd: projectRoot,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    mcpStderr += chunk.toString("utf8");
  });

  client = new Client({ name: "ai-teams-test-client", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(
      `Failed to connect to MCP server: ${error instanceof Error ? error.message : String(error)}\n${mcpStderr}`,
    );
  }
});

after(async () => {
  await client.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  await node.close();
});

interface ToolCallOutput {
  text: string;
  isError: boolean;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutput> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return {
    text: content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n"),
    isError: (result as { isError?: boolean }).isError === true,
  };
}

test("MCP server exposes the supervisor tool set", async () => {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "assign_task",
      "cancel_task",
      "create_employee",
      "disable_employee",
      "get_employee",
      "get_task",
      "get_task_result",
      "list_employees",
      "list_nodes",
      "list_pending_results",
      "list_tasks",
    ],
  );
});

test("MCP workflow creates an employee, runs a task, and returns the complete result", async () => {
  const nodes = await callTool("list_nodes", {});
  assert.equal(nodes.isError, false);
  const nodeList = JSON.parse(nodes.text) as Array<{ id: string; online: boolean }>;
  assert.equal(nodeList[0].online, true);

  const cwd = createWorkdir(node.workspace, "mcp-alice");
  const created = await callTool("create_employee", {
    nodeId: node.nodeId,
    name: "MCP Alice",
    cwd,
  });
  assert.equal(created.isError, false, created.text);
  const createPayload = JSON.parse(created.text) as { employee: { id: string } };

  const assigned = await callTool("assign_task", {
    employeeId: createPayload.employee.id,
    nodeId: node.nodeId,
    prompt: "MODE:long",
    source: "user",
  });
  assert.equal(assigned.isError, false, assigned.text);
  const assignPayload = JSON.parse(assigned.text) as { task: { id: string } };
  const taskId = assignPayload.task.id;

  const done = await waitFor(
    async () => {
      const detail = await callTool("get_task", { taskId });
      if (detail.isError) return null;
      const payload = JSON.parse(detail.text) as { task: { status: string } };
      return payload.task.status === "succeeded" ? payload : null;
    },
    20_000,
    "MCP task to succeed",
  );
  assert.equal((done as { task: { status: string } }).task.status, "succeeded");

  const pending = await callTool("list_pending_results", {});
  assert.equal(pending.isError, false);
  const pendingPayload = JSON.parse(pending.text) as { pending: Array<{ taskId: string }> };
  assert.ok(pendingPayload.pending.some((item) => item.taskId === taskId));

  const full = await callTool("get_task_result", { taskId });
  assert.equal(full.isError, false, full.text);
  assert.match(full.text, /===== TASK RESULT \(FULL TEXT\) =====/);
  assert.match(full.text, /LONG:/);
  assert.ok(full.text.length > 120_000, `result was truncated: ${full.text.length} chars`);

  const pendingAfter = await callTool("list_pending_results", {});
  const pendingAfterPayload = JSON.parse(pendingAfter.text) as {
    pending: Array<{ taskId: string }>;
  };
  assert.equal(
    pendingAfterPayload.pending.some((item) => item.taskId === taskId),
    false,
  );

  const nodeEvents = await api<TaskEvent[]>(node, "GET", "/api/events?unacked=true&limit=500");
  assert.equal(
    nodeEvents.data.some((event) => event.taskId === taskId),
    false,
  );

  const tasks = await api<Task[]>(node, "GET", `/api/tasks?employeeId=${createPayload.employee.id}`);
  assert.equal(tasks.data[0].status, "succeeded");
});
