import crypto from "node:crypto";
import { AppError, toErrorMessage } from "../shared/errors.js";
import { Logger } from "../shared/logger.js";
import { isTerminalTaskStatus } from "../shared/types.js";
import type {
  AssignmentSource,
  Employee,
  HarnessRuntimeInfo,
  PendingResult,
  Task,
  TaskEvent,
  TaskStatus,
} from "../shared/types.js";
import type { LoadedSupervisorConfig } from "./config.js";
import type { SupervisorStore, TaskQuery } from "./db.js";
import { NodeClient, type ListTasksParams } from "./node-client.js";

export interface NodeView {
  id: string;
  name: string;
  baseUrl: string;
  online: boolean;
  error?: string;
  version?: string;
  harnesses?: HarnessRuntimeInfo[];
}

export interface PublicEmployee {
  id: string;
  name: string;
  nodeId: string;
  harness: string;
  cwd: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicTask {
  id: string;
  nodeId: string;
  employeeId: string;
  employeeName: string | null;
  prompt: string;
  acceptanceCriteria: string | null;
  source: AssignmentSource;
  status: TaskStatus;
  timeoutMs: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  resultFetchedAt: string | null;
  hasResult: boolean;
  resultChars: number;
}

export interface TaskResultPayload {
  available: boolean;
  task: PublicTask;
  employeeName: string | null;
  node: NodeView;
  resultText: string | null;
  eventSeq: number | null;
  alreadyFetched: boolean;
  message: string | null;
}

export interface CreateEmployeeInput {
  nodeId: string;
  id?: string;
  name: string;
  cwd: string;
  harness?: "pi";
}

export interface AssignTaskInput {
  employeeId: string;
  nodeId?: string;
  prompt: string;
  acceptanceCriteria?: string | null;
  source?: AssignmentSource;
  timeoutMs?: number | null;
}

export interface ListEmployeesResult {
  employees: PublicEmployee[];
  nodes: NodeView[];
}

export interface ListTasksResult {
  tasks: PublicTask[];
  nodes: NodeView[];
}

export interface PublicEvent {
  seq: number;
  nodeId: string;
  taskId: string;
  employeeId: string;
  type: string;
  status: TaskStatus;
  error: string | null;
  createdAt: string;
  ackedAt: string | null;
  hasResult: boolean;
}

export interface TaskDetailResult {
  task: PublicTask;
  employeeName: string | null;
  node: NodeView;
  latestEvent: PublicEvent | null;
}

export interface ListPendingResult {
  pending: PendingResult[];
  nodes: NodeView[];
}

export class SupervisorService {
  private readonly store: SupervisorStore;
  private readonly logger: Logger;
  private readonly clients: NodeClient[];
  private readonly clientsById: Map<string, NodeClient>;

  constructor(config: LoadedSupervisorConfig, store: SupervisorStore, logger: Logger) {
    this.store = store;
    this.logger = logger;
    this.clients = config.nodes.map(
      (node) => new NodeClient(node, config.requestTimeoutMs),
    );
    this.clientsById = new Map(this.clients.map((client) => [client.id, client]));
    this.store.registerConfiguredNodes(
      config.nodes.map((node) => ({ id: node.id, name: node.name, baseUrl: node.baseUrl })),
    );
  }

  async listNodes(): Promise<NodeView[]> {
    const nodes = await Promise.all(this.clients.map((client) => this.refreshNode(client)));
    return nodes;
  }

  async listEmployees(options: {
    nodeId?: string;
    includeDisabled?: boolean;
  } = {}): Promise<ListEmployeesResult> {
    const clients = this.selectClients(options.nodeId);
    const nodeViews = await Promise.all(
      clients.map(async (client) => {
        const view = await this.refreshNode(client);
        if (view.online) {
          try {
            const employees = await client.listEmployees();
            this.store.upsertEmployees(client.id, employees, now());
          } catch (error) {
            this.markNodeError(client, error, view);
            view.online = false;
            view.error = toErrorMessage(error);
          }
        }
        return view;
      }),
    );

    const employees = this.store
      .listEmployees({
        nodeId: options.nodeId,
        includeDisabled: options.includeDisabled,
      })
      .map(toPublicEmployee);
    return { employees, nodes: nodeViews };
  }

  async getEmployee(nodeId: string, employeeId: string): Promise<{
    employee: PublicEmployee;
    node: NodeView;
  }> {
    const client = this.requireClient(nodeId);
    const node = await this.refreshNode(client);
    if (node.online) {
      try {
        const employee = await client.getEmployee(employeeId);
        this.store.upsertEmployees(client.id, [employee], now());
      } catch (error) {
        if (error instanceof AppError && error.code === "EMPLOYEE_NOT_FOUND") {
          throw error;
        }
        this.markNodeError(client, error, node);
        node.online = false;
        node.error = toErrorMessage(error);
      }
    }

    const cached = this.store
      .listEmployees({ nodeId, includeDisabled: true })
      .find((employee) => employee.id === employeeId);
    if (!cached) {
      throw new AppError(`Employee not found: ${employeeId}`, "EMPLOYEE_NOT_FOUND", 404);
    }
    return { employee: toPublicEmployee(cached), node };
  }

  async createEmployee(input: CreateEmployeeInput): Promise<{
    employee: PublicEmployee;
    node: NodeView;
  }> {
    const client = this.requireClient(input.nodeId);
    const name = input.name.trim();
    if (!name) throw new AppError("Employee name is required", "VALIDATION_ERROR", 400);
    const employee = await client.createEmployee({
      id: input.id?.trim() || `emp-${crypto.randomUUID()}`,
      name,
      harness: input.harness ?? "pi",
      cwd: input.cwd,
    });
    this.store.upsertEmployees(client.id, [employee], now());
    const node = await this.refreshNode(client);
    this.store.setNodeOnline(client.node, now());
    return { employee: toPublicEmployee(employee), node };
  }

  async disableEmployee(nodeId: string, employeeId: string): Promise<{
    employee: PublicEmployee;
    node: NodeView;
  }> {
    const client = this.requireClient(nodeId);
    const employee = await client.disableEmployee(employeeId);
    this.store.upsertEmployees(client.id, [employee], now());
    const node = await this.refreshNode(client);
    this.store.setNodeOnline(client.node, now());
    return { employee: toPublicEmployee(employee), node };
  }

  async assignTask(input: AssignTaskInput): Promise<{
    task: PublicTask;
    employee: PublicEmployee;
    node: NodeView;
  }> {
    const prompt = input.prompt;
    if (!prompt.trim()) throw new AppError("Task prompt is required", "VALIDATION_ERROR", 400);
    const employee = await this.resolveEmployee(input.employeeId, input.nodeId);
    const client = this.requireClient(employee.nodeId);
    const task = await client.createTask({
      id: `task-${crypto.randomUUID()}`,
      employeeId: employee.id,
      prompt,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      source: input.source ?? "supervisor",
      timeoutMs: input.timeoutMs ?? null,
    });
    this.store.upsertTask(client.id, task, employee.name, now());
    const node = await this.refreshNode(client);
    this.store.setNodeOnline(client.node, now());
    this.logger.info("task assigned", {
      taskId: task.id,
      employeeId: employee.id,
      nodeId: client.id,
      source: task.source,
    });
    return {
      task: toPublicTask(task, "preview", employee.name),
      employee,
      node,
    };
  }

  async listTasks(options: {
    nodeId?: string;
    employeeId?: string;
    status?: TaskStatus;
    limit?: number;
  } = {}): Promise<ListTasksResult> {
    let clients = this.selectClients(options.nodeId);
    if (options.employeeId && !options.nodeId) {
      const employee = await this.resolveEmployee(options.employeeId);
      clients = [this.requireClient(employee.nodeId)];
    }

    const nodeViews = await Promise.all(
      clients.map(async (client) => {
        const view = await this.refreshNode(client);
        if (!view.online) return view;
        try {
          const params: ListTasksParams = {
            employeeId: options.employeeId,
            status: options.status,
            limit: options.limit,
          };
          const tasks = await client.listTasks(params);
          const names = new Map(
            this.store.listEmployees({ nodeId: client.id, includeDisabled: true })
              .map((employee) => [employee.id, employee.name]),
          );
          for (const task of tasks) {
            this.store.upsertTask(client.id, task, names.get(task.employeeId) ?? null, now());
          }
        } catch (error) {
          this.markNodeError(client, error, view);
          view.online = false;
          view.error = toErrorMessage(error);
        }
        return view;
      }),
    );

    const query: TaskQuery = {
      nodeId: options.nodeId,
      employeeId: options.employeeId,
      status: options.status,
      limit: options.limit,
    };
    const tasks = this.store
      .listTasks(query)
      .map((task) => toPublicTask(task, "preview", this.employeeNameFor(task)));
    return { tasks, nodes: nodeViews };
  }

  async getTask(taskId: string): Promise<TaskDetailResult> {
    const resolved = await this.resolveTask(taskId);
    const employeeName = this.employeeNameFor(resolved.task);
    const event = this.store.getLatestEventForTask(taskId);
    return {
      task: toPublicTask(resolved.task, "full", employeeName),
      employeeName,
      node: resolved.node,
      latestEvent: event ? toPublicEvent(event) : null,
    };
  }

  async listPendingResults(options: { nodeId?: string } = {}): Promise<ListPendingResult> {
    const clients = this.selectClients(options.nodeId);
    const nodeViews = await Promise.all(
      clients.map(async (client) => {
        const view = await this.refreshNode(client);
        if (!view.online) return view;
        try {
          await this.flushAcks(client);
          const events = await client.listEvents({ unackedOnly: true, limit: 500 });
          for (const event of events) {
            this.store.upsertEvent(client.id, event, now());
          }
        } catch (error) {
          this.markNodeError(client, error, view);
          view.online = false;
          view.error = toErrorMessage(error);
        }
        return view;
      }),
    );

    const pending = this.store.listPendingEvents(options.nodeId, 500);
    return { pending, nodes: nodeViews };
  }

  async getTaskResult(taskId: string): Promise<TaskResultPayload> {
    const resolved = await this.resolveTask(taskId);
    const { task, node, client } = resolved;
    const employeeName = this.employeeNameFor(task);
    const alreadyFetched = task.resultFetchedAt != null;

    if (!isTerminalTaskStatus(task.status)) {
      return {
        available: false,
        task: toPublicTask(task, "full", employeeName),
        employeeName,
        node,
        resultText: null,
        eventSeq: null,
        alreadyFetched,
        message: `Task is still ${task.status}. The result is not available yet.`,
      };
    }

    let currentTask = task;
    let eventSeq: number | null = null;
    let resultText: string | null = null;
    let currentEmployeeName = employeeName;
    let currentNode = node;
    let fetchError: string | null = null;

    if (currentNode.online) {
      try {
        const response = await client.getTaskResult(task.id);
        currentTask = response.task;
        eventSeq = response.eventSeq;
        resultText = response.task.resultText;
        this.store.upsertTask(client.id, currentTask, currentEmployeeName, now());
        this.store.setNodeOnline(client.node, now());
        currentEmployeeName = this.employeeNameFor(currentTask) ?? currentEmployeeName;
      } catch (error) {
        fetchError = toErrorMessage(error);
        this.markNodeError(client, error, currentNode);
        currentNode = { ...currentNode, online: false, error: fetchError };
      }
    }

    if (resultText === null) {
      resultText = currentTask.resultText;
    }
    if (resultText === null) {
      const event = this.store.getLatestEventForTask(task.id);
      resultText = event?.resultText ?? null;
      if (event) eventSeq = event.seq;
    }

    if (resultText === null) {
      resultText = terminalFallbackReport(currentTask, fetchError);
    }

    if (eventSeq === null) {
      const event = this.store.getLatestEventForTask(task.id);
      eventSeq = event?.seq ?? null;
    }
    if (eventSeq !== null) {
      this.store.markResultDelivered(client.id, task.id, eventSeq, now());
      try {
        await client.ackEvents([eventSeq]);
        this.store.markEventsNodeAcked(client.id, [eventSeq], now());
      } catch (error) {
        this.logger.debug("failed to ack result event", {
          taskId,
          eventSeq,
          error: toErrorMessage(error),
        });
      }
    }

    const refreshed = this.store.getTask(task.id) ?? currentTask;
    return {
      available: true,
      task: toPublicTask(refreshed, "full", currentEmployeeName),
      employeeName: currentEmployeeName,
      node: currentNode,
      resultText,
      eventSeq,
      alreadyFetched,
      message: null,
    };
  }

  async cancelTask(taskId: string): Promise<{
    task: PublicTask;
    employeeName: string | null;
    node: NodeView;
  }> {
    const resolved = await this.resolveTask(taskId);
    const { client } = resolved;
    if (!resolved.node.online) {
      throw new AppError(
        `Node ${client.id} is offline; the task cannot be canceled`,
        "NODE_UNREACHABLE",
        503,
      );
    }

    const task = await client.cancelTask(taskId);
    const employeeName = this.employeeNameFor(task);
    this.store.upsertTask(client.id, task, employeeName, now());
    this.store.setNodeOnline(client.node, now());

    try {
      const events = await client.listEvents({ unackedOnly: true, limit: 500 });
      for (const event of events) {
        this.store.upsertEvent(client.id, event, now());
      }
    } catch (error) {
      this.logger.debug("failed to sync events after cancel", {
        taskId,
        error: toErrorMessage(error),
      });
    }

    return {
      task: toPublicTask(task, "preview", employeeName),
      employeeName,
      node: await this.refreshNode(client),
    };
  }

  private async resolveTask(
    taskId: string,
  ): Promise<{ task: Task; node: NodeView; client: NodeClient }> {
    const cached = this.store.getTask(taskId);
    if (cached) {
      const client = this.requireClient(cached.nodeId);
      const node = await this.refreshNode(client);
      if (node.online) {
        try {
          const task = await client.getTask(taskId);
          const employeeName = this.employeeNameFor(task);
          this.store.upsertTask(client.id, task, employeeName, now());
          return { task: this.store.getTask(taskId) ?? task, node, client };
        } catch (error) {
          if (error instanceof AppError && error.code === "TASK_NOT_FOUND") {
            throw error;
          }
          this.markNodeError(client, error, node);
          node.online = false;
          node.error = toErrorMessage(error);
        }
      }
      return { task: cached, node, client };
    }

    const failures: string[] = [];
    for (const client of this.clients) {
      try {
        const task = await client.getTask(taskId);
        const employeeName = this.employeeNameFor(task);
        this.store.upsertTask(client.id, task, employeeName, now());
        const node = await this.refreshNode(client);
        return { task: this.store.getTask(taskId) ?? task, node, client };
      } catch (error) {
        failures.push(`${client.id}: ${toErrorMessage(error)}`);
      }
    }

    throw new AppError(
      `Task not found on any node: ${taskId}. ${failures.join("; ")}`,
      "TASK_NOT_FOUND",
      404,
    );
  }

  private async resolveEmployee(employeeId: string, nodeId?: string): Promise<PublicEmployee> {
    if (nodeId) {
      const client = this.requireClient(nodeId);
      const candidates = this.store.listEmployeesById(employeeId);
      const cached = candidates.find((employee) => employee.nodeId === nodeId);
      if (cached) return toPublicEmployee(cached);
      const employee = await client.getEmployee(employeeId);
      this.store.upsertEmployees(client.id, [employee], now());
      return toPublicEmployee(employee);
    }

    const cached = this.store.listEmployeesById(employeeId);
    if (cached.length === 1) return toPublicEmployee(cached[0]);
    if (cached.length > 1) {
      throw new AppError(
        `Employee id ${employeeId} exists on multiple nodes; specify nodeId`,
        "AMBIGUOUS_EMPLOYEE",
        409,
      );
    }

    for (const client of this.clients) {
      try {
        const employees = await client.listEmployees();
        this.store.upsertEmployees(client.id, employees, now());
      } catch (error) {
        this.logger.debug("employee lookup failed on node", {
          nodeId: client.id,
          error: toErrorMessage(error),
        });
      }
    }

    const matches = this.store.listEmployeesById(employeeId);
    if (matches.length === 1) return toPublicEmployee(matches[0]);
    if (matches.length > 1) {
      throw new AppError(
        `Employee id ${employeeId} exists on multiple nodes; specify nodeId`,
        "AMBIGUOUS_EMPLOYEE",
        409,
      );
    }
    throw new AppError(`Employee not found: ${employeeId}`, "EMPLOYEE_NOT_FOUND", 404);
  }

  private employeeNameFor(task: Task): string | null {
    const employees = this.store.listEmployees({ nodeId: task.nodeId, includeDisabled: true });
    return employees.find((employee) => employee.id === task.employeeId)?.name ?? null;
  }

  private selectClients(nodeId?: string): NodeClient[] {
    if (!nodeId) return this.clients;
    return [this.requireClient(nodeId)];
  }

  private requireClient(nodeId: string): NodeClient {
    const client = this.clientsById.get(nodeId);
    if (!client) {
      throw new AppError(`Unknown node: ${nodeId}`, "NODE_NOT_CONFIGURED", 404);
    }
    return client;
  }

  private async refreshNode(client: NodeClient): Promise<NodeView> {
    try {
      const health = await client.health();
      this.store.setNodeOnline(client.node, now());
      return {
        id: client.id,
        name: client.name,
        baseUrl: client.baseUrl,
        online: true,
        version: health.version,
        harnesses: health.harnesses,
      };
    } catch (error) {
      this.store.setNodeOffline(client.node, toErrorMessage(error));
      return {
        id: client.id,
        name: client.name,
        baseUrl: client.baseUrl,
        online: false,
        error: toErrorMessage(error),
      };
    }
  }

  private markNodeError(client: NodeClient, error: unknown, view: NodeView): void {
    this.store.setNodeOffline(client.node, toErrorMessage(error));
    this.logger.debug("node request failed", {
      nodeId: client.id,
      error: toErrorMessage(error),
      wasOnline: view.online,
    });
  }

  private async flushAcks(client: NodeClient): Promise<void> {
    const seqs = this.store.listEventsAwaitingAck(client.id, 500);
    if (seqs.length === 0) return;
    try {
      await client.ackEvents(seqs);
      this.store.markEventsNodeAcked(client.id, seqs, now());
    } catch (error) {
      this.logger.debug("failed to flush result acks", {
        nodeId: client.id,
        error: toErrorMessage(error),
      });
    }
  }
}

function toPublicEmployee(employee: Employee): PublicEmployee {
  return {
    id: employee.id,
    name: employee.name,
    nodeId: employee.nodeId,
    harness: employee.harness,
    cwd: employee.cwd,
    enabled: employee.enabled,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
  };
}

function toPublicTask(
  task: Task,
  promptMode: "full" | "preview",
  employeeName: string | null = null,
): PublicTask {
  return {
    id: task.id,
    nodeId: task.nodeId,
    employeeId: task.employeeId,
    employeeName,
    prompt:
      promptMode === "full" || task.prompt.length <= 300
        ? task.prompt
        : `${task.prompt.slice(0, 300)}...`,
    acceptanceCriteria: task.acceptanceCriteria,
    source: task.source,
    status: task.status,
    timeoutMs: task.timeoutMs,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    updatedAt: task.updatedAt,
    resultFetchedAt: task.resultFetchedAt ?? null,
    hasResult: task.resultText !== null,
    resultChars: task.resultText?.length ?? 0,
  };
}

function toPublicEvent(event: TaskEvent): PublicEvent {
  return {
    seq: event.seq,
    nodeId: event.nodeId,
    taskId: event.taskId,
    employeeId: event.employeeId,
    type: event.type,
    status: event.status,
    error: event.error,
    createdAt: event.createdAt,
    ackedAt: event.ackedAt,
    hasResult: event.resultText !== null,
  };
}

function terminalFallbackReport(task: Task, fetchError: string | null): string {
  const lines = [
    "No employee result text was produced for this task.",
    `Status: ${task.status}`,
  ];
  if (task.error) lines.push(`Error: ${task.error}`);
  if (fetchError) lines.push(`Node fetch error: ${fetchError}`);
  return lines.join("\n");
}

function now(): string {
  return new Date().toISOString();
}
