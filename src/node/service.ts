import crypto from "node:crypto";
import path from "node:path";
import { AppError } from "../shared/errors.js";
import { Logger } from "../shared/logger.js";
import { pathKey, resolveAllowedCwd } from "../shared/paths.js";
import type {
  CreateEmployeeRequest,
  CreateTaskRequest,
  Employee,
  HarnessRuntimeInfo,
  NodeHealth,
  Task,
  TaskEvent,
  TaskResultResponse,
} from "../shared/types.js";
import { isTerminalTaskStatus } from "../shared/types.js";
import type { NodeConfig, PiHarnessConfig } from "./config.js";
import type { EventFilter, NodeStore, TaskFilter, TerminalStatus } from "./db.js";
import { readHarnessVersion, startPiRun, type PiRun } from "./pi-runner.js";

export const DEFAULT_APPEND_SYSTEM_PROMPT =
  'You are an employee agent in an AI team. Your manager assigns one task at a time. ' +
  'If you cannot complete the task because you need a decision, missing credentials, or missing information, ' +
  'start your final message with "NEEDS_INPUT:" followed by a concise question. ' +
  "Otherwise complete the task and report the outcome.";

export interface NodeServiceOptions {
  config: NodeConfig;
  allowedRoots: string[];
  logDir: string;
  store: NodeStore;
  logger: Logger;
}

interface RunningRecord {
  task: Task;
  employee: Employee;
  run: PiRun;
  settled: boolean;
  timeout: NodeJS.Timeout | null;
}

export type TaskListFilter = TaskFilter;

export class NodeService {
  private readonly config: NodeConfig;
  private readonly allowedRoots: string[];
  private readonly logDir: string;
  private readonly store: NodeStore;
  private readonly logger: Logger;
  private readonly harness: PiHarnessConfig;
  private readonly appendSystemPrompt: string;
  private readonly running = new Map<string, RunningRecord>();
  private runtimeInfo: HarnessRuntimeInfo;
  private shuttingDown = false;

  constructor(options: NodeServiceOptions) {
    this.config = options.config;
    this.allowedRoots = options.allowedRoots;
    this.logDir = options.logDir;
    this.store = options.store;
    this.logger = options.logger;
    this.harness = options.config.harnesses.pi;
    this.appendSystemPrompt = options.config.appendSystemPrompt ?? DEFAULT_APPEND_SYSTEM_PROMPT;
    this.runtimeInfo = {
      type: "pi",
      command: this.harness.command,
      expectedVersion: this.harness.version ?? null,
      actualVersion: null,
      versionMatches: null,
    };
  }

  async start(): Promise<void> {
    const interrupted = this.store.markRunningTasksInterrupted(this.config.nodeId, now());
    for (const event of interrupted) {
      this.logger.warn("task interrupted by node restart", {
        taskId: event.taskId,
        employeeId: event.employeeId,
      });
    }

    await this.refreshHarnessVersion();

    const employees = this.store.listEmployees();
    for (const employee of employees) {
      this.scheduleEmployee(employee.id);
    }
    this.logger.info("node service started", {
      nodeId: this.config.nodeId,
      employees: employees.length,
      interrupted: interrupted.length,
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const records = [...this.running.values()];
    for (const record of records) {
      if (record.timeout) {
        clearTimeout(record.timeout);
        record.timeout = null;
      }
      if (!record.settled) {
        const event = this.store.finishRunningTaskWithEvent(
          record.task.id,
          this.config.nodeId,
          "interrupted",
          "Node agent stopped while the task was running",
          null,
          now(),
        );
        record.settled = true;
        if (event) {
          this.logger.warn("task interrupted by node shutdown", { taskId: event.taskId });
        }
      }
      record.run.kill();
    }

    const closed = Promise.allSettled(records.map((record) => record.run.result));
    await Promise.race([closed, sleep(5000)]);
    this.logger.info("node service stopped");
  }

  getHealth(): NodeHealth {
    return {
      ok: true,
      nodeId: this.config.nodeId,
      name: this.config.name,
      version: this.config.version,
      now: now(),
      harnesses: [this.runtimeInfo],
    };
  }

  listEmployees(): Employee[] {
    return this.store.listEmployees().map((employee) => this.withNode(employee));
  }

  getEmployee(id: string): Employee {
    return this.withNode(this.store.getEmployee(id) ?? this.notFoundEmployee(id));
  }

  createEmployee(request: CreateEmployeeRequest): Employee {
    validateId(request.id, "employee id");
    const name = request.name.trim();
    if (!name) {
      throw new AppError("Employee name is required", "VALIDATION_ERROR", 400);
    }
    if (name.length > 100) {
      throw new AppError("Employee name is too long", "VALIDATION_ERROR", 400);
    }
    if (request.harness !== "pi") {
      throw new AppError(
        `Harness ${request.harness} is not available on this node`,
        "HARNESS_UNAVAILABLE",
        400,
      );
    }

    const cwd = resolveAllowedCwd(request.cwd, this.allowedRoots);
    const employee = this.store.createEmployee({
      id: request.id,
      name,
      harness: request.harness,
      cwd,
      cwdKey: pathKey(cwd),
      sessionId: crypto.randomUUID(),
      now: now(),
    });
    this.logger.info("employee created", { employeeId: employee.id, cwd: employee.cwd });
    return this.withNode(employee);
  }

  disableEmployee(id: string): Employee {
    const employee = this.store.disableEmployee(id, now());
    this.logger.info("employee disabled", { employeeId: employee.id });
    return this.withNode(employee);
  }

  listTasks(filter: TaskListFilter = {}): Task[] {
    return this.store.listTasks(filter).map((task) => this.withNode(task));
  }

  getTask(id: string): Task {
    return this.withNode(this.store.requireTask(id));
  }

  getTaskResult(id: string): TaskResultResponse {
    const task = this.store.requireTask(id);
    const event = this.store.getLatestEventForTask(id);
    return { task: this.withNode(task), eventSeq: event ? event.seq : null };
  }

  createTask(request: CreateTaskRequest): Task {
    validateId(request.id, "task id");
    const prompt = request.prompt;
    if (!prompt.trim()) {
      throw new AppError("Task prompt is required", "VALIDATION_ERROR", 400);
    }
    if (prompt.length > this.config.maxPromptChars) {
      throw new AppError(
        `Task prompt exceeds the node limit of ${this.config.maxPromptChars} characters`,
        "PROMPT_TOO_LONG",
        400,
      );
    }
    if (request.acceptanceCriteria && request.acceptanceCriteria.length > 20_000) {
      throw new AppError("Acceptance criteria is too long", "VALIDATION_ERROR", 400);
    }
    if (request.source !== "user" && request.source !== "supervisor") {
      throw new AppError("Task source must be user or supervisor", "VALIDATION_ERROR", 400);
    }
    const timeoutMs = normalizeTimeout(request.timeoutMs);

    const existing = this.store.getTask(request.id);
    if (existing) {
      if (
        existing.employeeId === request.employeeId &&
        existing.prompt === request.prompt &&
        existing.source === request.source
      ) {
        return this.withNode(existing);
      }
      throw new AppError(
        `Task id ${request.id} is already used by a different task`,
        "TASK_ID_CONFLICT",
        409,
      );
    }

    const employee = this.store.getEmployee(request.employeeId);
    if (!employee) {
      throw new AppError(`Employee not found: ${request.employeeId}`, "EMPLOYEE_NOT_FOUND", 404);
    }
    if (!employee.enabled) {
      throw new AppError(`Employee is disabled: ${employee.id}`, "EMPLOYEE_DISABLED", 409);
    }

    const task = this.store.createTask({
      id: request.id,
      employeeId: request.employeeId,
      prompt,
      acceptanceCriteria: request.acceptanceCriteria ?? null,
      source: request.source,
      timeoutMs,
      now: now(),
    });
    this.logger.info("task queued", {
      taskId: task.id,
      employeeId: task.employeeId,
      source: task.source,
      timeoutMs: task.timeoutMs,
    });
    this.scheduleEmployee(task.employeeId);
    return this.withNode(this.store.requireTask(task.id));
  }

  cancelTask(id: string): Task {
    const task = this.store.requireTask(id);
    if (isTerminalTaskStatus(task.status)) {
      throw new AppError(`Task is already ${task.status}`, "TASK_ALREADY_FINISHED", 409);
    }

    const event = this.store.cancelOpenTaskWithEvent(id, this.config.nodeId, now());
    if (!event) {
      throw new AppError(
        `Task ${id} could not be canceled in status ${this.store.requireTask(id).status}`,
        "TASK_CANCEL_FAILED",
        409,
      );
    }

    const record = this.running.get(task.employeeId);
    const wasRunning = record?.task.id === task.id;
    if (record && wasRunning) {
      record.settled = true;
      if (record.timeout) {
        clearTimeout(record.timeout);
        record.timeout = null;
      }
      record.run.kill();
    }

    this.logger.info("task canceled", { taskId: id, wasRunning });
    if (!wasRunning) {
      this.scheduleEmployee(task.employeeId);
    }
    return this.withNode(this.store.requireTask(id));
  }

  listEvents(filter: EventFilter): TaskEvent[] {
    return this.store.listEvents(filter);
  }

  ackEvents(seqs: number[]): number {
    return this.store.ackEvents(seqs, now());
  }

  private scheduleEmployee(employeeId: string): void {
    if (this.shuttingDown || this.running.has(employeeId)) return;
    const employee = this.store.getEmployee(employeeId);
    if (!employee) return;

    const next = this.store.getNextQueuedTask(employeeId);
    if (!next) return;
    const startedAt = now();
    if (!this.store.startTask(next.id, startedAt)) return;
    const task = this.store.requireTask(next.id);

    const run = startPiRun({
      command: this.harness.command,
      baseArgs: this.harness.args,
      cwd: employee.cwd,
      sessionId: employee.sessionId,
      prompt: buildPrompt(task),
      appendSystemPrompt: this.appendSystemPrompt,
      stdoutLogPath: path.join(this.logDir, "tasks", `${task.id}.jsonl`),
      stderrLogPath: path.join(this.logDir, "tasks", `${task.id}.stderr.log`),
    });

    const record: RunningRecord = {
      task,
      employee,
      run,
      settled: false,
      timeout: null,
    };
    this.running.set(employeeId, record);

    if (task.timeoutMs != null) {
      record.timeout = setTimeout(() => {
        this.handleTimeout(record);
      }, task.timeoutMs);
    }

    this.logger.info("task running", {
      taskId: task.id,
      employeeId,
      pid: run.pid,
      timeoutMs: task.timeoutMs,
    });
    void this.observeRun(record);
  }

  private async observeRun(record: RunningRecord): Promise<void> {
    const outcome = await record.run.result;
    const employeeId = record.employee.id;

    try {
      if (!record.settled) {
        const task = this.store.getTask(record.task.id);
        if (task && task.status === "running") {
          if (outcome.spawnError) {
            this.finishTask(
              record,
              "failed",
              `Failed to start harness: ${outcome.spawnError}`,
              null,
            );
          } else if (outcome.exitCode === 0) {
            const text = outcome.text.trim() ? outcome.text : null;
            if (!text) {
              this.finishTask(record, "failed", "Harness returned no assistant text", null);
            } else if (/^\s*NEEDS_INPUT\s*:/i.test(outcome.text)) {
              this.finishTask(record, "needs_input", null, outcome.text);
            } else {
              this.finishTask(record, "succeeded", null, outcome.text);
            }
          } else {
            const reason =
              outcome.signal != null
                ? `Harness was terminated by signal ${outcome.signal}`
                : `Harness exited with code ${outcome.exitCode}`;
            this.finishTask(record, "failed", withStderr(reason, outcome.stderrTail), outcome.text.trim() ? outcome.text : null);
          }
        }
      }
    } catch (error) {
      this.logger.error("failed to finalize task", {
        taskId: record.task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (record.timeout) {
        clearTimeout(record.timeout);
        record.timeout = null;
      }
      record.settled = true;
      if (this.running.get(employeeId) === record) {
        this.running.delete(employeeId);
      }
      this.scheduleEmployee(employeeId);
    }
  }

  private handleTimeout(record: RunningRecord): void {
    if (record.settled) return;
    const timeoutMs = record.task.timeoutMs ?? 0;
    const event = this.store.finishRunningTaskWithEvent(
      record.task.id,
      this.config.nodeId,
      "failed",
      `Task timed out after ${timeoutMs} ms`,
      null,
      now(),
    );
    record.settled = true;
    record.timeout = null;
    record.run.kill();
    if (event) {
      this.logger.warn("task timed out", { taskId: record.task.id, timeoutMs });
    }
  }

  private finishTask(
    record: RunningRecord,
    status: TerminalStatus,
    error: string | null,
    resultText: string | null,
  ): void {
    const event = this.store.finishRunningTaskWithEvent(
      record.task.id,
      this.config.nodeId,
      status,
      error,
      resultText,
      now(),
    );
    if (!event) {
      this.logger.warn("task finished but status was already changed", {
        taskId: record.task.id,
      });
      return;
    }
    record.settled = true;
    this.logger.info("task finished", {
      taskId: record.task.id,
      employeeId: record.employee.id,
      status,
      resultChars: resultText?.length ?? 0,
    });
  }

  private async refreshHarnessVersion(): Promise<void> {
    const actual = await readHarnessVersion(this.harness.command, this.harness.args);
    const expected = this.harness.version ?? null;
    const versionMatches = expected && actual ? actual === expected : null;
    this.runtimeInfo = {
      type: "pi",
      command: this.harness.command,
      expectedVersion: expected,
      actualVersion: actual,
      versionMatches,
    };
    if (!actual) {
      this.logger.warn("could not determine pi version", { command: this.harness.command });
    } else if (versionMatches === false) {
      this.logger.warn("pi version does not match pinned version", { expected, actual });
    } else {
      this.logger.info("pi harness ready", { version: actual });
    }
  }

  private withNode<T extends Employee | Task>(value: T): T {
    return { ...value, nodeId: this.config.nodeId };
  }

  private notFoundEmployee(id: string): never {
    throw new AppError(`Employee not found: ${id}`, "EMPLOYEE_NOT_FOUND", 404);
  }
}

function buildPrompt(task: Task): string {
  if (!task.acceptanceCriteria) return task.prompt;
  return `${task.prompt}\n\nAcceptance criteria:\n${task.acceptanceCriteria}`;
}

function normalizeTimeout(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("timeoutMs must be a positive integer", "VALIDATION_ERROR", 400);
  }
  if (value > 7 * 24 * 60 * 60 * 1000) {
    throw new AppError("timeoutMs cannot exceed 7 days", "VALIDATION_ERROR", 400);
  }
  return value;
}

function validateId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new AppError(
      `${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}`,
      "VALIDATION_ERROR",
      400,
    );
  }
}

function withStderr(reason: string, stderrTail: string): string {
  const tail = stderrTail.trim();
  if (!tail) return reason;
  return `${reason}. Harness stderr (tail):\n${tail.slice(-2000)}`;
}

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
