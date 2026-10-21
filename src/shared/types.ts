export const HARNESS_TYPES = ["pi", "claude-code", "opencode"] as const;
export type HarnessType = (typeof HARNESS_TYPES)[number];

export const ASSIGNMENT_SOURCES = ["user", "supervisor"] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_input",
  "interrupted",
  "canceled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "needs_input",
  "interrupted",
  "canceled",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export const TASK_EVENT_TYPES = [
  "task.succeeded",
  "task.failed",
  "task.needs_input",
  "task.interrupted",
  "task.canceled",
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export interface Employee {
  id: string;
  name: string;
  nodeId: string;
  harness: HarnessType;
  cwd: string;
  sessionId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  employeeId: string;
  nodeId: string;
  prompt: string;
  acceptanceCriteria: string | null;
  source: AssignmentSource;
  status: TaskStatus;
  timeoutMs: number | null;
  error: string | null;
  resultText: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  resultFetchedAt?: string | null;
}

export interface TaskEvent {
  seq: number;
  nodeId: string;
  taskId: string;
  employeeId: string;
  type: TaskEventType;
  status: TaskStatus;
  error: string | null;
  resultText: string | null;
  createdAt: string;
  ackedAt: string | null;
}

export interface HarnessRuntimeInfo {
  type: HarnessType;
  command: string;
  expectedVersion: string | null;
  actualVersion: string | null;
  versionMatches: boolean | null;
}

export interface NodeHealth {
  ok: true;
  nodeId: string;
  name: string;
  version: string;
  now: string;
  harnesses: HarnessRuntimeInfo[];
}

export interface CreateEmployeeRequest {
  id: string;
  name: string;
  harness: HarnessType;
  cwd: string;
}

export interface CreateTaskRequest {
  id: string;
  employeeId: string;
  prompt: string;
  acceptanceCriteria?: string | null;
  source: AssignmentSource;
  timeoutMs?: number | null;
}

export interface TaskResultResponse {
  task: Task;
  eventSeq: number | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface NodeStatus {
  id: string;
  name: string;
  baseUrl: string;
  online: boolean;
  error?: string;
}

export interface PendingResult {
  nodeId: string;
  nodeName: string;
  taskId: string;
  employeeId: string | null;
  employeeName: string | null;
  status: TaskStatus;
  type: TaskEventType;
  eventSeq: number;
  finishedAt: string;
}
