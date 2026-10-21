import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDirectory } from "../shared/paths.js";
import type {
  AssignmentSource,
  Employee,
  HarnessType,
  PendingResult,
  Task,
  TaskEvent,
  TaskEventType,
  TaskStatus,
} from "../shared/types.js";

interface EmployeeRow {
  node_id: string;
  id: string;
  name: string;
  harness: string;
  cwd: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

interface TaskRow {
  id: string;
  node_id: string;
  employee_id: string;
  employee_name: string | null;
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
  result_fetched_at: string | null;
  synced_at: string;
}

interface EventRow {
  node_id: string;
  seq: number;
  task_id: string;
  employee_id: string;
  type: string;
  status: string;
  error: string | null;
  result_text: string | null;
  created_at: string;
  first_seen_at: string;
  delivered_at: string | null;
  node_acked_at: string | null;
}

interface PendingRow extends EventRow {
  node_name: string | null;
  task_employee_name: string | null;
  employee_name: string | null;
}

export interface SupervisorNodeState {
  id: string;
  name: string;
  baseUrl: string;
  online: boolean;
  lastSeenAt: string | null;
  error: string | null;
}

export interface TaskQuery {
  nodeId?: string;
  employeeId?: string;
  status?: TaskStatus;
  limit?: number;
}

export class SupervisorStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    ensureDirectory(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS employees (
        node_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        harness TEXT NOT NULL,
        cwd TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (node_id, id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        employee_name TEXT,
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
        updated_at TEXT NOT NULL,
        result_fetched_at TEXT,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_node ON tasks(node_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_employee ON tasks(node_id, employee_id);

      CREATE TABLE IF NOT EXISTS events (
        node_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        result_text TEXT,
        created_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        delivered_at TEXT,
        node_acked_at TEXT,
        PRIMARY KEY (node_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_pending ON events(delivered_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  registerConfiguredNodes(nodes: Array<{ id: string; name: string; baseUrl: string }>): void {
    const statement = this.db.prepare(
      `INSERT INTO nodes (id, name, base_url, online, last_seen_at, last_error)
       VALUES (?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url`,
    );
    this.transaction(() => {
      for (const node of nodes) {
        statement.run(node.id, node.name, node.baseUrl);
      }
    });
  }

  setNodeOnline(node: { id: string; name: string; baseUrl: string }, at: string): void {
    this.db
      .prepare(
        `INSERT INTO nodes (id, name, base_url, online, last_seen_at, last_error)
         VALUES (?, ?, ?, 1, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           online = 1,
           last_seen_at = excluded.last_seen_at,
           last_error = NULL`,
      )
      .run(node.id, node.name, node.baseUrl, at);
  }

  setNodeOffline(node: { id: string; name: string; baseUrl: string }, error: string): void {
    this.db
      .prepare(
        `INSERT INTO nodes (id, name, base_url, online, last_seen_at, last_error)
         VALUES (?, ?, ?, 0, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           online = 0,
           last_error = excluded.last_error`,
      )
      .run(node.id, node.name, node.baseUrl, error);
  }

  listNodes(): SupervisorNodeState[] {
    const rows = this.db.prepare("SELECT * FROM nodes ORDER BY id ASC").all() as unknown as Array<{
      id: string;
      name: string;
      base_url: string;
      online: number;
      last_seen_at: string | null;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      online: row.online === 1,
      lastSeenAt: row.last_seen_at,
      error: row.last_error,
    }));
  }

  upsertEmployees(nodeId: string, employees: Employee[], syncedAt: string): void {
    const statement = this.db.prepare(
      `INSERT INTO employees
       (node_id, id, name, harness, cwd, enabled, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id, id) DO UPDATE SET
         name = excluded.name,
         harness = excluded.harness,
         cwd = excluded.cwd,
         enabled = excluded.enabled,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`,
    );
    this.transaction(() => {
      for (const employee of employees) {
        statement.run(
          nodeId,
          employee.id,
          employee.name,
          employee.harness,
          employee.cwd,
          employee.enabled ? 1 : 0,
          employee.createdAt,
          employee.updatedAt,
          syncedAt,
        );
      }
    });
  }

  listEmployees(filter: { nodeId?: string; includeDisabled?: boolean } = {}): Employee[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.nodeId) {
      clauses.push("node_id = ?");
      params.push(filter.nodeId);
    }
    if (!filter.includeDisabled) {
      clauses.push("enabled = 1");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM employees ${where} ORDER BY node_id ASC, name ASC`)
      .all(...params) as unknown as EmployeeRow[];
    return rows.map(mapEmployee);
  }

  listEmployeesById(employeeId: string): Employee[] {
    const rows = this.db
      .prepare("SELECT * FROM employees WHERE id = ? ORDER BY node_id ASC")
      .all(employeeId) as unknown as EmployeeRow[];
    return rows.map(mapEmployee);
  }

  upsertTask(nodeId: string, task: Task, employeeName: string | null, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, node_id, employee_id, employee_name, prompt, acceptance_criteria, source,
          status, timeout_ms, error, result_text, created_at, started_at, finished_at,
          updated_at, result_fetched_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           node_id = excluded.node_id,
           employee_id = excluded.employee_id,
           employee_name = COALESCE(excluded.employee_name, tasks.employee_name),
           prompt = excluded.prompt,
           acceptance_criteria = excluded.acceptance_criteria,
           source = excluded.source,
           status = excluded.status,
           timeout_ms = excluded.timeout_ms,
           error = excluded.error,
           result_text = excluded.result_text,
           created_at = excluded.created_at,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`,
      )
      .run(
        task.id,
        nodeId,
        task.employeeId,
        employeeName,
        task.prompt,
        task.acceptanceCriteria,
        task.source,
        task.status,
        task.timeoutMs,
        task.error,
        task.resultText,
        task.createdAt,
        task.startedAt,
        task.finishedAt,
        task.updatedAt,
        syncedAt,
      );
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row ? mapTask(row) : null;
  }

  listTasks(query: TaskQuery = {}): Task[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.nodeId) {
      clauses.push("node_id = ?");
      params.push(query.nodeId);
    }
    if (query.employeeId) {
      clauses.push("employee_id = ?");
      params.push(query.employeeId);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  upsertEvent(nodeId: string, event: TaskEvent, seenAt: string): void {
    this.db
      .prepare(
        `INSERT INTO events
         (node_id, seq, task_id, employee_id, type, status, error, result_text,
          created_at, first_seen_at, delivered_at, node_acked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(node_id, seq) DO UPDATE SET
           task_id = excluded.task_id,
           employee_id = excluded.employee_id,
           type = excluded.type,
           status = excluded.status,
           error = excluded.error,
           result_text = excluded.result_text,
           created_at = excluded.created_at`,
      )
      .run(
        nodeId,
        event.seq,
        event.taskId,
        event.employeeId,
        event.type,
        event.status,
        event.error,
        event.resultText,
        event.createdAt,
        seenAt,
      );
  }

  getLatestEventForTask(taskId: string): TaskEvent | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1")
      .get(taskId) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  listPendingEvents(nodeId?: string, limit = 200): PendingResult[] {
    const params: Array<string | number> = [];
    let nodeClause = "";
    if (nodeId) {
      nodeClause = "AND e.node_id = ?";
      params.push(nodeId);
    }
    params.push(Math.min(Math.max(limit, 1), 500));
    const rows = this.db
      .prepare(
        `SELECT e.*, n.name AS node_name,
                t.employee_name AS task_employee_name,
                emp.name AS employee_name
         FROM events e
         LEFT JOIN nodes n ON n.id = e.node_id
         LEFT JOIN tasks t ON t.id = e.task_id
         LEFT JOIN employees emp ON emp.node_id = e.node_id AND emp.id = e.employee_id
         WHERE e.delivered_at IS NULL ${nodeClause}
         ORDER BY e.created_at ASC, e.node_id ASC, e.seq ASC
         LIMIT ?`,
      )
      .all(...params) as unknown as PendingRow[];
    return rows.map((row) => ({
      nodeId: row.node_id,
      nodeName: row.node_name ?? row.node_id,
      taskId: row.task_id,
      employeeId: row.employee_id,
      employeeName: row.task_employee_name ?? row.employee_name,
      status: row.status as TaskStatus,
      type: row.type as TaskEventType,
      eventSeq: Number(row.seq),
      finishedAt: row.created_at,
    }));
  }

  markResultDelivered(nodeId: string, taskId: string, seq: number, at: string): void {
    this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE events SET delivered_at = COALESCE(delivered_at, ?) WHERE node_id = ? AND seq = ?",
        )
        .run(at, nodeId, seq);
      if (Number(result.changes) === 0) {
        const task = this.getTask(taskId);
        if (task) {
          this.db
            .prepare(
              `INSERT INTO events
               (node_id, seq, task_id, employee_id, type, status, error, result_text,
                created_at, first_seen_at, delivered_at, node_acked_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            )
            .run(
              nodeId,
              seq,
              task.id,
              task.employeeId,
              `task.${task.status}`,
              task.status,
              task.error,
              task.resultText,
              task.finishedAt ?? at,
              at,
              at,
            );
        }
      }
      this.db.prepare("UPDATE tasks SET result_fetched_at = ? WHERE id = ?").run(at, taskId);
    });
  }

  listEventsAwaitingAck(nodeId: string, limit = 500): number[] {
    const rows = this.db
      .prepare(
        `SELECT seq FROM events
         WHERE node_id = ? AND delivered_at IS NOT NULL AND node_acked_at IS NULL
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(nodeId, limit) as unknown as Array<{ seq: number }>;
    return rows.map((row) => Number(row.seq));
  }

  markEventsNodeAcked(nodeId: string, seqs: number[], at: string): void {
    if (seqs.length === 0) return;
    const statement = this.db.prepare(
      "UPDATE events SET node_acked_at = ? WHERE node_id = ? AND seq = ?",
    );
    this.transaction(() => {
      for (const seq of seqs) statement.run(at, nodeId, seq);
    });
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
    nodeId: row.node_id,
    harness: row.harness as HarnessType,
    cwd: row.cwd,
    sessionId: "",
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    employeeId: row.employee_id,
    nodeId: row.node_id,
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
    resultFetchedAt: row.result_fetched_at,
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
    ackedAt: row.node_acked_at,
  };
}
