import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppError, toErrorMessage } from "../shared/errors.js";
import { Logger } from "../shared/logger.js";
import { TASK_STATUSES } from "../shared/types.js";
import { loadSupervisorConfig } from "./config.js";
import { SupervisorStore } from "./db.js";
import { SupervisorService, type TaskResultPayload } from "./service.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const configArg = readConfigArg(process.argv.slice(2));
  const loaded = loadSupervisorConfig(configArg);
  const logger = new Logger("supervisor", path.join(loaded.logDir, "supervisor-mcp.log"));
  const store = new SupervisorStore(loaded.dbPath);
  const service = new SupervisorService(loaded, store, logger);

  const server = new McpServer({ name: "ai-teams-supervisor", version: VERSION });

  registerTools(server, service, logger);

  const shutdown = async (reason: string) => {
    logger.info("MCP server shutting down", { reason });
    try {
      await server.close();
    } finally {
      store.close();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("end", () => void shutdown("stdin end"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected", {
    config: loaded.configPath,
    nodes: loaded.nodes.map((node) => node.id),
  });
}

function registerTools(
  server: McpServer,
  service: SupervisorService,
  logger: Logger,
): void {
  server.registerTool(
    "list_nodes",
    {
      title: "List worker nodes",
      description:
        "Check every configured worker node over the LAN. Returns node id, name, baseUrl, online status, agent version, and installed harness versions. Call this first when you need to know which nodes are reachable.",
      inputSchema: z.object({}),
    },
    async () => runTool(logger, "list_nodes", async () => jsonResult(await service.listNodes())),
  );

  server.registerTool(
    "list_employees",
    {
      title: "List employees",
      description:
        "List employees across worker nodes, including their node, name, harness, working directory, enabled state, and node online status. Use this to map a user's employee name to an employee id before assigning work. Cached data is returned for offline nodes.",
      inputSchema: z.object({
        nodeId: z.string().optional().describe("Only list employees on this node id"),
        includeDisabled: z.boolean().optional().describe("Include disabled employees (default false)"),
      }),
    },
    async (args) =>
      runTool(logger, "list_employees", async () =>
        jsonResult(await service.listEmployees(args)),
      ),
  );

  server.registerTool(
    "get_employee",
    {
      title: "Get employee",
      description:
        "Get one employee by node id and employee id, including whether the node is currently online. Uses cached data when the node is offline.",
      inputSchema: z.object({
        nodeId: z.string().describe("Node id from list_nodes"),
        employeeId: z.string().describe("Employee id from list_employees"),
      }),
    },
    async (args) =>
      runTool(logger, "get_employee", async () =>
        jsonResult(await service.getEmployee(args.nodeId, args.employeeId)),
      ),
  );

  server.registerTool(
    "create_employee",
    {
      title: "Create employee",
      description:
        "Create a new employee (a persistent pi harness session) on a worker node. The working directory must be an absolute path that already exists on the node, be inside one of the node's allowed roots, and must not be shared with another employee. Creation fails immediately if the node is offline. Ask the user for the node, employee name, and working directory if they did not specify them.",
      inputSchema: z.object({
        nodeId: z.string().describe("Node id from list_nodes"),
        name: z.string().describe("Display name for the employee"),
        cwd: z.string().describe("Absolute working directory on the node"),
        harness: z.literal("pi").optional().describe("Harness type; currently only pi"),
        id: z.string().optional().describe("Optional explicit employee id"),
      }),
    },
    async (args) =>
      runTool(logger, "create_employee", async () => jsonResult(await service.createEmployee(args))),
  );

  server.registerTool(
    "disable_employee",
    {
      title: "Disable employee",
      description:
        "Disable an employee so no new tasks can be assigned. Already queued or running tasks are not canceled. This currently cannot be undone from the tools; report that clearly to the user.",
      inputSchema: z.object({
        nodeId: z.string().describe("Node id"),
        employeeId: z.string().describe("Employee id"),
      }),
    },
    async (args) =>
      runTool(logger, "disable_employee", async () =>
        jsonResult(await service.disableEmployee(args.nodeId, args.employeeId)),
      ),
  );

  server.registerTool(
    "assign_task",
    {
      title: "Assign task to employee",
      description:
        "Assign one task to an existing employee. The employee runs tasks one at a time; additional tasks are queued in FIFO order. Use source=\"user\" when the user explicitly chose this employee, and source=\"supervisor\" when you selected the employee yourself. The tool fails immediately if the node is offline or the employee is disabled. Rejection, revision, or reassignment must be a NEW task containing the previous report as context; never modify or resubmit the old task as if it were the same work.",
      inputSchema: z.object({
        employeeId: z.string().describe("Employee id from list_employees"),
        nodeId: z.string().optional().describe("Node id if known; helps resolve duplicate ids"),
        prompt: z.string().describe("Complete task instructions for the employee"),
        acceptanceCriteria: z
          .string()
          .nullable()
          .optional()
          .describe("Optional acceptance criteria appended to the task prompt"),
        source: z
          .enum(["user", "supervisor"])
          .optional()
          .describe("Who chose the employee: user or supervisor; default supervisor"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Optional timeout in milliseconds; omit for no timeout"),
      }),
    },
    async (args) =>
      runTool(logger, "assign_task", async () => jsonResult(await service.assignTask(args))),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List recent tasks, optionally filtered by node, employee, or status. Returns task metadata and whether result text exists, but never returns the full result text. Use get_task_result to load a completed result.",
      inputSchema: z.object({
        nodeId: z.string().optional(),
        employeeId: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
    },
    async (args) =>
      runTool(logger, "list_tasks", async () => jsonResult(await service.listTasks(args))),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Get one task's metadata, latest lifecycle event, and node status. Does not include the full result text; use get_task_result for that.",
      inputSchema: z.object({
        taskId: z.string().describe("Task id"),
      }),
    },
    async (args) =>
      runTool(logger, "get_task", async () => jsonResult(await service.getTask(args.taskId))),
  );

  server.registerTool(
    "list_pending_results",
    {
      title: "List pending results",
      description:
        "Synchronize terminal task events from worker nodes and list results that have NOT yet been delivered to the supervisor. Only tasks that have reached a terminal status are included; running tasks never appear here, so poll get_task or list_tasks first if the task may still be executing. Returns metadata only (task, employee, status, event sequence, finish time). Call get_task_result for each task whose full result you need. Works from the supervisor cache when a node is offline.",
      inputSchema: z.object({
        nodeId: z.string().optional().describe("Only check this node"),
      }),
    },
    async (args) =>
      runTool(logger, "list_pending_results", async () => {
        const result = await service.listPendingResults(args);
        return jsonResult({
          ...result,
          note: "Call get_task_result with a taskId to load the complete report and acknowledge it.",
        });
      }),
  );

  server.registerTool(
    "get_task_result",
    {
      title: "Get task result (full text)",
      description:
        "Retrieve the employee's COMPLETE final result text for a terminal task, persist it in the supervisor database, inject it into this conversation, and acknowledge the corresponding node event. If the task ended without employee output (interrupted, canceled, or failed before producing text), this returns a complete status and error report instead. Never claim or summarize a result without calling this tool first. For needs_input tasks the full text contains the employee's question. This tool does not truncate the result.",
      inputSchema: z.object({
        taskId: z.string().describe("Task id"),
      }),
    },
    async (args) =>
      runTool(logger, "get_task_result", async () =>
        formatResult(await service.getTaskResult(args.taskId)),
      ),
  );

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel task",
      description:
        "Explicitly cancel a queued or running task. Running harness processes are terminated as a process tree. Cancellation is only performed when the user explicitly asks for it. The node must be online.",
      inputSchema: z.object({
        taskId: z.string().describe("Task id"),
      }),
    },
    async (args) =>
      runTool(logger, "cancel_task", async () => jsonResult(await service.cancelTask(args.taskId))),
  );
}

async function runTool(
  logger: Logger,
  toolName: string,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    const result = await fn();
    logger.debug("tool call succeeded", { tool: toolName });
    return result;
  } catch (error) {
    const message = error instanceof AppError
      ? `[${error.code}] ${error.message}`
      : toErrorMessage(error);
    logger.warn("tool call failed", { tool: toolName, error: message });
    return {
      isError: true,
      content: [{ type: "text", text: `Tool ${toolName} failed: ${message}` }],
    };
  }
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function formatResult(payload: TaskResultPayload): CallToolResult {
  const task = payload.task;
  const header = [
    `Task: ${task.id}`,
    `Employee: ${payload.employeeName ?? task.employeeId} (${task.employeeId})`,
    `Node: ${payload.node.id}`,
    `Status: ${task.status}`,
    `Finished: ${task.finishedAt ?? "unknown"}`,
    `Event seq: ${payload.eventSeq ?? "none"}`,
    `Already fetched: ${payload.alreadyFetched ? "yes" : "no"}`,
    `Node online: ${payload.node.online ? "yes" : "no"}`,
  ].join("\n");

  if (!payload.available || payload.resultText === null) {
    return {
      content: [
        {
          type: "text",
          text: `${header}\n\nNO RESULT TEXT AVAILABLE\n${payload.message ?? ""}`.trimEnd(),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `${header}\n\n===== TASK RESULT (FULL TEXT) =====\n${payload.resultText}\n===== END TASK RESULT =====`,
      },
    ],
  };
}

function readConfigArg(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") return argv[index + 1];
    if (value.startsWith("--config=")) return value.slice("--config=".length);
  }
  return undefined;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to start supervisor MCP server: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
