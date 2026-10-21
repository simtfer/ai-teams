import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Logger } from "../src/shared/logger.js";
import { findProjectRoot } from "../src/shared/paths.js";
import { NodeStore } from "../src/node/db.js";
import { NodeService } from "../src/node/service.js";
import { createNodeServer } from "../src/node/server.js";
import type { NodeConfig } from "../src/node/config.js";
import type { Task, TaskStatus } from "../src/shared/types.js";
import { toErrorMessage } from "../src/shared/errors.js";

export const projectRoot = findProjectRoot();
export const fakePiPath = path.join(projectRoot, "test", "fixtures", "fake-pi.mjs");

export interface TestNode {
  baseUrl: string;
  token: string;
  nodeId: string;
  workspace: string;
  dataDir: string;
  fakeStateDir: string;
  server: http.Server;
  service: NodeService;
  store: NodeStore;
  close(): Promise<void>;
  stopHttp(): Promise<void>;
}

export interface TestNodeOptions {
  nodeId?: string;
}

export async function startTestNode(options: TestNodeOptions = {}): Promise<TestNode> {
  process.env.LOG_LEVEL = "error";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-node-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const fakeStateDir = path.join(root, "fake-state");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(fakeStateDir, { recursive: true });

  const nodeId = options.nodeId ?? `node-${crypto.randomUUID().slice(0, 8)}`;
  const token = `test-token-${crypto.randomUUID()}`;
  const config: NodeConfig = {
    nodeId,
    name: "Test node",
    host: "127.0.0.1",
    port: 1,
    token,
    dataDir,
    allowedRoots: [workspace],
    harnesses: {
      pi: {
        command: process.execPath,
        args: [fakePiPath],
        version: "1.3.0",
      },
    },
    appendSystemPrompt: undefined,
    maxPromptChars: 200_000,
    version: "0.1.0",
  };

  const previousFakeState = process.env.AI_TEAMS_FAKE_PI_STATE;
  process.env.AI_TEAMS_FAKE_PI_STATE = fakeStateDir;

  const logger = new Logger("test-node");
  const store = new NodeStore(path.join(dataDir, "node.db"));
  const service = new NodeService({
    config,
    allowedRoots: [workspace],
    logDir: path.join(dataDir, "logs"),
    store,
    logger,
  });
  await service.start();

  const server = createNodeServer({
    service,
    token,
    logger,
    maxPromptChars: config.maxPromptChars,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let httpStopped = false;

  const stopHttp = async (): Promise<void> => {
    if (httpStopped) return;
    httpStopped = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  return {
    baseUrl,
    token,
    nodeId,
    workspace,
    dataDir,
    fakeStateDir,
    server,
    service,
    store,
    stopHttp,
    async close(): Promise<void> {
      await stopHttp();
      await service.shutdown();
      store.close();
      if (previousFakeState === undefined) {
        delete process.env.AI_TEAMS_FAKE_PI_STATE;
      } else {
        process.env.AI_TEAMS_FAKE_PI_STATE = previousFakeState;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

export async function api<T = unknown>(
  node: Pick<TestNode, "baseUrl" | "token">,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${node.baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${node.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: (text ? JSON.parse(text) : undefined) as T,
  };
}

export function createWorkdir(workspace: string, name: string): string {
  const directory = path.join(workspace, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export async function createEmployee(
  node: TestNode,
  name: string,
  cwdName = name,
): Promise<{ id: string; name: string; cwd: string }> {
  const id = `emp-${crypto.randomUUID()}`;
  const cwd = createWorkdir(node.workspace, cwdName);
  const response = await api<{ id: string; name: string; cwd: string }>(
    node,
    "POST",
    "/api/employees",
    { id, name, harness: "pi", cwd },
  );
  if (response.status !== 201) {
    throw new Error(`Failed to create employee: ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

export async function createTask(
  node: TestNode,
  employeeId: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<Task> {
  const id = `task-${crypto.randomUUID()}`;
  const response = await api<Task>(node, "POST", "/api/tasks", {
    id,
    employeeId,
    prompt,
    source: "user",
    ...extra,
  });
  if (response.status !== 201) {
    throw new Error(`Failed to create task: ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

export async function waitForTaskStatus(
  node: Pick<TestNode, "baseUrl" | "token">,
  taskId: string,
  statuses: TaskStatus[],
  timeoutMs = 20_000,
): Promise<Task> {
  return waitFor(
    async () => {
      const response = await api<Task>(node, "GET", `/api/tasks/${taskId}`);
      if (response.status !== 200) {
        throw new Error(`Task lookup failed: ${JSON.stringify(response.data)}`);
      }
      return statuses.includes(response.data.status) ? response.data : null;
    },
    timeoutMs,
    `task ${taskId} to become ${statuses.join("/")}`,
  );
}

export async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}${
      lastError ? `: ${toErrorMessage(lastError)}` : ""
    }`,
  );
}

export interface FakeRun {
  sessionId: string;
  cwd: string;
  prompt: string;
  at: number;
}

export function readFakeRuns(stateDir: string): FakeRun[] {
  const file = path.join(stateDir, "runs.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeRun);
}

export function readGrandchildPid(stateDir: string): number | null {
  const file = path.join(stateDir, "grandchild.pid");
  if (!fs.existsSync(file)) return null;
  return Number(fs.readFileSync(file, "utf8").trim());
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeSupervisorConfig(
  root: string,
  nodes: Array<{ id: string; name: string; baseUrl: string; token: string }>,
): string {
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "supervisor.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        dataDir: "../data/supervisor",
        requestTimeoutMs: 5000,
        nodes,
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
}

export function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
