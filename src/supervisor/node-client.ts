import { AppError } from "../shared/errors.js";
import type {
  ApiErrorBody,
  CreateEmployeeRequest,
  CreateTaskRequest,
  Employee,
  NodeHealth,
  Task,
  TaskEvent,
  TaskResultResponse,
} from "../shared/types.js";
import type { ResolvedNodeConfig } from "./config.js";

export interface ListEventsParams {
  unackedOnly?: boolean;
  afterSeq?: number;
  limit?: number;
}

export interface ListTasksParams {
  employeeId?: string;
  status?: string;
  limit?: number;
}

export class NodeClient {
  constructor(
    readonly node: ResolvedNodeConfig,
    private readonly timeoutMs: number,
  ) {}

  get id(): string {
    return this.node.id;
  }

  get name(): string {
    return this.node.name;
  }

  get baseUrl(): string {
    return this.node.baseUrl;
  }

  async health(): Promise<NodeHealth> {
    const health = await this.request<NodeHealth>("GET", "/health");
    if (health.nodeId !== this.node.id) {
      throw new AppError(
        `Node id mismatch: config expects ${this.node.id}, node reports ${health.nodeId}`,
        "NODE_ID_MISMATCH",
        502,
      );
    }
    return health;
  }

  async listEmployees(): Promise<Employee[]> {
    const employees = await this.request<Employee[]>("GET", "/api/employees");
    return employees.map((employee) => ({ ...employee, nodeId: this.node.id }));
  }

  async getEmployee(employeeId: string): Promise<Employee> {
    const employee = await this.request<Employee>(
      "GET",
      `/api/employees/${encodeURIComponent(employeeId)}`,
    );
    return { ...employee, nodeId: this.node.id };
  }

  async createEmployee(request: CreateEmployeeRequest): Promise<Employee> {
    const employee = await this.request<Employee>("POST", "/api/employees", request);
    return { ...employee, nodeId: this.node.id };
  }

  async disableEmployee(employeeId: string): Promise<Employee> {
    const employee = await this.request<Employee>(
      "POST",
      `/api/employees/${encodeURIComponent(employeeId)}/disable`,
    );
    return { ...employee, nodeId: this.node.id };
  }

  async listTasks(params: ListTasksParams = {}): Promise<Task[]> {
    const query = new URLSearchParams();
    if (params.employeeId) query.set("employeeId", params.employeeId);
    if (params.status) query.set("status", params.status);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const tasks = await this.request<Task[]>("GET", `/api/tasks${suffix}`);
    return tasks.map((task) => ({ ...task, nodeId: this.node.id }));
  }

  async getTask(taskId: string): Promise<Task> {
    const task = await this.request<Task>("GET", `/api/tasks/${encodeURIComponent(taskId)}`);
    return { ...task, nodeId: this.node.id };
  }

  async createTask(request: CreateTaskRequest): Promise<Task> {
    const task = await this.request<Task>("POST", "/api/tasks", request);
    return { ...task, nodeId: this.node.id };
  }

  async cancelTask(taskId: string): Promise<Task> {
    const task = await this.request<Task>(
      "POST",
      `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
    );
    return { ...task, nodeId: this.node.id };
  }

  async getTaskResult(taskId: string): Promise<TaskResultResponse> {
    const result = await this.request<TaskResultResponse>(
      "GET",
      `/api/tasks/${encodeURIComponent(taskId)}/result`,
    );
    return { ...result, task: { ...result.task, nodeId: this.node.id } };
  }

  async listEvents(params: ListEventsParams = {}): Promise<TaskEvent[]> {
    const query = new URLSearchParams();
    query.set("unacked", params.unackedOnly === false ? "false" : "true");
    if (params.afterSeq !== undefined) query.set("afterSeq", String(params.afterSeq));
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    const events = await this.request<TaskEvent[]>("GET", `/api/events?${query.toString()}`);
    return events.map((event) => ({ ...event, nodeId: this.node.id }));
  }

  async ackEvents(seqs: number[]): Promise<number> {
    if (seqs.length === 0) return 0;
    const response = await this.request<{ acked: number }>("POST", "/api/events/ack", { seqs });
    return response.acked;
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.node.baseUrl}${pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.node.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof Error && error.name === "TimeoutError"
        ? "NODE_TIMEOUT"
        : "NODE_UNREACHABLE";
      throw new AppError(
        `Node ${this.node.id} is unavailable at ${this.node.baseUrl}: ${message}`,
        code,
        503,
        error,
      );
    }

    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new AppError(
            `Node ${this.node.id} returned invalid JSON for ${method} ${pathname}`,
            "NODE_PROTOCOL_ERROR",
            502,
          );
        }
      }
    }

    if (!response.ok) {
      const apiError = payload as ApiErrorBody | undefined;
      const code = apiError?.error?.code ?? `NODE_HTTP_${response.status}`;
      const message = apiError?.error?.message ?? response.statusText ?? "Request failed";
      throw new AppError(`Node ${this.node.id}: ${message}`, code, response.status);
    }

    return payload as T;
  }
}
