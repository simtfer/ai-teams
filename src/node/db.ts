import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../shared/errors.js";
import { ensureDirectory } from "../shared/paths.js";
import type {
  Task,
  TaskEvent,
  TaskEventType,
  TaskStatus,
  HarnessType,
  AssignmentSource,
  Employee,
} from "../shared/types.js";
import { isTerminalTaskStatus } from "../shared/types.js";

interface EmployeeRow {
  id: string;
  name: string;
  harness: string;
  cwd: string;
  cwd_key: string;
  session_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  employee_id: string;
  prompt: string;
  acceptance_criteria: string | null;
  source: string;
  status: string;
  timeout_ms: number | null;
  error: string | null;
  result_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface EventRow {
  seq: number;
  node_id: string;
  task_id: string;
  employee_id: string;
  type: string;
  status: string;
  error: string | null;
  result_text: string | null;
  created_at: string;
  acked_at: string | null;
}

export interface CreateEmployeeRecord {
  id: string;
  name: string;
  harness: HarnessType;
  cwd: string;
  cwdKey: string;
  sessionId: string;
  now: string;
}

export interface CreateTaskRecord {
  id: string;
  employeeId: string;
  prompt: string;
  acceptanceCriteria: string | null;
  source: AssignmentSource;
  timeoutMs: number | null;
  now: string;
}

export interface TaskFilter {
  employeeId?: string;
  status?: TaskStatus;
  limit?: number;
}

export interface EventFilter {
  unackedOnly: boolean;
  afterSeq?: number;
  limit?: number;
}

export type TerminalStatus = Extract<
  TaskStatus,
  "succeeded" | "failed" | "needs_input" | "interrupted" | "canceled"
>;

export class NodeStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    ensureDirectory(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        harness TEXT NOT NULL,
        cwd TEXT NOT NULL,
        cwd_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_cwd_key ON employees(cwd_key);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        prompt TEXT NOT NULL,
        acceptance_criteria TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        timeout_ms INTEGER,
        error TEXT,
        result_text TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_employee_status ON tasks(employee_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        employee_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        result_text TEXT,
        created_at TEXT NOT NULL,
        acked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_unacked ON events(acked_at, seq);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  createEmployee(record: CreateEmployeeRecord): Employee {
    if (this.getEmployee(record.id)) {
      throw new AppError(`Employee already exists: ${record.id}`, "EMPLOYEE_EXISTS", 409);
    }
    const cwdOwner = this.db
      .prepare("SELECT id FROM employees WHERE cwd_key = ?")
      .get(record.cwdKey) as { id: string } | undefined;
    if (cwdOwner) {
      throw new AppError(
        `Working directory is already used by employee ${cwdOwner.id}`,
        "CWD_IN_USE",
        409,
      );
    }

    this.db
      .prepare(
        `INSERT INTO employees
         (id, name, harness, cwd, cwd_key, session_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.harness,
        record.cwd,
        record.cwdKey,
        record.sessionId,
        record.now,
        record.now,
      );
    return this.requireEmployee(record.id);
  }

  getEmployee(id: string): Employee | null {
    const row = this.db.prepare("SELECT * FROM employees WHERE id = ?").get(id) as
      | EmployeeRow
      | undefined;
    return row ? mapEmployee(row) : null;
  }

  listEmployees(): Employee[] {
    const rows = this.db
      .prepare("SELECT * FROM employees ORDER BY created_at ASC, rowid ASC")
      .all() as unknown as EmployeeRow[];
    return rows.map(mapEmployee);
  }

  disableEmployee(id: string, now: string): Employee {
    const employee = this.requireEmployee(id);
    if (!employee.enabled) return employee;
    this.db
      .prepare("UPDATE employees SET enabled = 0, updated_at = ? WHERE id = ?")
      .run(now, id);
    return this.requireEmployee(id);
  }

  createTask(record: CreateTaskRecord): Task {
    if (this.getTask(record.id)) {
      throw new AppError(`Task already exists: ${record.id}`, "TASK_EXISTS", 409);
    }
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, employee_id, prompt, acceptance_criteria, source, status, timeout_ms,
          error, result_text, created_at, started_at, finished_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, NULL, NULL, ?)`,
      )
      .run(
        record.id,
        record.employeeId,
        record.prompt,
        record.acceptanceCriteria,
        record.source,
        record.timeoutMs,
        record.now,
        record.now,
      );
    return this.requireTask(record.id);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row ? mapTask(row) : null;
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.employeeId) {
      clauses.push("employee_id = ?");
      params.push(filter.employeeId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  getRunningTask(employeeId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE employee_id = ? AND status = 'running' LIMIT 1")
      .get(employeeId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  getNextQueuedTask(employeeId: string): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE employee_id = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1",
      )
      .get(employeeId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  startTask(taskId: string, startedAt: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(startedAt, startedAt, taskId);
    return Number(result.changes) > 0;
  }

  finishRunningTaskWithEvent(
    taskId: string,
    nodeId: string,
    status: TerminalStatus,
    error: string | null,
    resultText: string | null,
    finishedAt: string,
  ): TaskEvent | null {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET status = ?, error = ?, result_text = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(status, error, resultText, finishedAt, finishedAt, taskId);
      if (Number(result.changes) === 0) return null;
      return this.insertEvent(taskId, nodeId, status, error, resultText, finishedAt);
    });
  }

  cancelOpenTaskWithEvent(
    taskId: string,
    nodeId: string,
    finishedAt: string,
  ): TaskEvent | null {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'canceled', error = NULL, result_text = NULL, finished_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(finishedAt, finishedAt, taskId);
      if (Number(result.changes) === 0) return null;
      return this.insertEvent(taskId, nodeId, "canceled", null, null, finishedAt);
    });
  }

  markRunningTasksInterrupted(nodeId: string, now: string): TaskEvent[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY rowid ASC")
        .all() as unknown as TaskRow[];
      const events: TaskEvent[] = [];
      for (const row of rows) {
        const task = mapTask(row);
        const error = "Node agent restarted while the task was running";
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'interrupted', error = ?, finished_at = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(error, now, now, task.id);
        events.push(this.insertEvent(task.id, nodeId, "interrupted", error, null, now));
      }
      return events;
    });
  }

  getLatestEventForTask(taskId: string): TaskEvent | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 1")
      .get(taskId) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  listEvents(filter: EventFilter): TaskEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const afterSeq = filter.afterSeq ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE seq > ? AND (? = 0 OR acked_at IS NULL)
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(afterSeq, filter.unackedOnly ? 1 : 0, limit) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  ackEvents(seqs: number[], ackedAt: string): number {
    const unique = [...new Set(seqs.filter((seq) => Number.isInteger(seq) && seq > 0))];
    if (unique.length === 0) return 0;
    let acked = 0;
    this.transaction(() => {
      const statement = this.db.prepare(
        "UPDATE events SET acked_at = ? WHERE seq = ? AND acked_at IS NULL",
      );
      for (const seq of unique) {
        const result = statement.run(ackedAt, seq);
        acked += Number(result.changes);
      }
    });
    return acked;
  }

  countRunningTasks(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'")
      .get() as { count: number };
    return Number(row.count);
  }

  private insertEvent(
    taskId: string,
    nodeId: string,
    status: TerminalStatus,
    error: string | null,
    resultText: string | null,
    createdAt: string,
  ): TaskEvent {
    const task = this.requireTask(taskId);
    if (!isTerminalTaskStatus(status)) {
      throw new AppError(`Not a terminal status: ${status}`, "INTERNAL_ERROR", 500);
    }
    const type = `task.${status}` as TaskEventType;
    const result = this.db
      .prepare(
        `INSERT INTO events
         (node_id, task_id, employee_id, type, status, error, result_text, created_at, acked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(nodeId, taskId, task.employeeId, type, status, error, resultText, createdAt);
    const seq = Number(result.lastInsertRowid);
    const row = this.db.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as
      | EventRow
      | undefined;
    if (!row) {
      throw new AppError(`Failed to read event ${seq}`, "INTERNAL_ERROR", 500);
    }
    return mapEvent(row);
  }

  private requireEmployee(id: string): Employee {
    const employee = this.getEmployee(id);
    if (!employee) {
      throw new AppError(`Employee not found: ${id}`, "EMPLOYEE_NOT_FOUND", 404);
    }
    return employee;
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) {
      throw new AppError(`Task not found: ${id}`, "TASK_NOT_FOUND", 404);
    }
    return task;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    name: row.name,
    nodeId: "",
    harness: row.harness as HarnessType,
    cwd: row.cwd,
    sessionId: row.session_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    employeeId: row.employee_id,
    nodeId: "",
    prompt: row.prompt,
    acceptanceCriteria: row.acceptance_criteria,
    source: row.source as AssignmentSource,
    status: row.status as TaskStatus,
    timeoutMs: row.timeout_ms,
    error: row.error,
    resultText: row.result_text,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): TaskEvent {
  return {
    seq: Number(row.seq),
    nodeId: row.node_id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    type: row.type as TaskEventType,
    status: row.status as TaskStatus,
    error: row.error,
    resultText: row.result_text,
    createdAt: row.created_at,
    ackedAt: row.acked_at,
  };
}

