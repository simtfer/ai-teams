import crypto from "node:crypto";
import http from "node:http";
import { z } from "zod";
import { AppError } from "../shared/errors.js";
import { Logger } from "../shared/logger.js";
import { HARNESS_TYPES, TASK_STATUSES } from "../shared/types.js";
import type { ApiErrorBody } from "../shared/types.js";
import type { NodeService } from "./service.js";

const createEmployeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  harness: z.enum(HARNESS_TYPES),
  cwd: z.string(),
});

const createTaskSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  prompt: z.string(),
  acceptanceCriteria: z.string().nullable().optional(),
  source: z.enum(["user", "supervisor"]),
  timeoutMs: z.number().int().positive().nullable().optional(),
});

const ackSchema = z.object({
  seqs: z.array(z.number().int().positive()).max(500),
});

export interface NodeServerOptions {
  service: NodeService;
  token: string;
  logger: Logger;
  maxPromptChars: number;
}

export function createNodeServer(options: NodeServerOptions): http.Server {
  const { service, token, logger } = options;
  const maxBodyBytes = Math.max(1024 * 1024, options.maxPromptChars * 4 + 100_000);

  const server = http.createServer((request, response) => {
    const startedAt = Date.now();
    void handleRequest(request, response)
      .catch((error: unknown) => {
        sendError(response, error, logger);
      })
      .finally(() => {
        logger.debug("http request", {
          method: request.method,
          url: request.url,
          status: response.statusCode,
          durationMs: Date.now() - startedAt,
        });
      });
  });

  async function handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (!isAuthorized(request, token)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, errorBody("UNAUTHORIZED", "Invalid or missing bearer token"));
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && parts.length === 1 && parts[0] === "health") {
      sendJson(response, 200, service.getHealth());
      return;
    }

    if (parts[0] !== "api") {
      throw new AppError(`Route not found: ${url.pathname}`, "NOT_FOUND", 404);
    }

    if (parts[1] === "employees") {
      await handleEmployees(request, response, url, parts);
      return;
    }
    if (parts[1] === "tasks") {
      await handleTasks(request, response, url, parts);
      return;
    }
    if (parts[1] === "events") {
      await handleEvents(request, response, url, parts);
      return;
    }

    throw new AppError(`Route not found: ${url.pathname}`, "NOT_FOUND", 404);
  }

  async function handleEmployees(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    parts: string[],
  ): Promise<void> {
    if (parts.length === 2 && request.method === "GET") {
      sendJson(response, 200, service.listEmployees());
      return;
    }

    if (parts.length === 2 && request.method === "POST") {
      const body = parseBody(createEmployeeSchema, await readJson(request, maxBodyBytes));
      const employee = service.createEmployee(body);
      sendJson(response, 201, employee);
      return;
    }

    if (parts.length === 3 && request.method === "GET") {
      sendJson(response, 200, service.getEmployee(decodeId(parts[2])));
      return;
    }

    if (parts.length === 4 && parts[3] === "disable" && request.method === "POST") {
      sendJson(response, 200, service.disableEmployee(decodeId(parts[2])));
      return;
    }

    throw new AppError(`Route not found: ${request.method} ${url.pathname}`, "NOT_FOUND", 404);
  }

  async function handleTasks(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    parts: string[],
  ): Promise<void> {
    if (parts.length === 2 && request.method === "GET") {
      const employeeId = url.searchParams.get("employeeId") ?? undefined;
      const status = parseStatus(url.searchParams.get("status"));
      const limit = parseLimit(url.searchParams.get("limit"));
      sendJson(response, 200, service.listTasks({ employeeId, status, limit }));
      return;
    }

    if (parts.length === 2 && request.method === "POST") {
      const body = parseBody(createTaskSchema, await readJson(request, maxBodyBytes));
      const task = service.createTask(body);
      sendJson(response, 201, task);
      return;
    }

    if (parts.length === 3 && request.method === "GET") {
      sendJson(response, 200, service.getTask(decodeId(parts[2])));
      return;
    }

    if (parts.length === 4 && parts[3] === "result" && request.method === "GET") {
      sendJson(response, 200, service.getTaskResult(decodeId(parts[2])));
      return;
    }

    if (parts.length === 4 && parts[3] === "cancel" && request.method === "POST") {
      sendJson(response, 200, service.cancelTask(decodeId(parts[2])));
      return;
    }

    throw new AppError(`Route not found: ${request.method} ${url.pathname}`, "NOT_FOUND", 404);
  }

  async function handleEvents(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    parts: string[],
  ): Promise<void> {
    if (parts.length === 2 && request.method === "GET") {
      const unackedParam = url.searchParams.get("unacked");
      const unackedOnly = unackedParam === null ? true : !["0", "false", "no"].includes(unackedParam);
      const afterSeq = parseNonNegativeInt(url.searchParams.get("afterSeq"), "afterSeq", 0);
      const limit = parseLimit(url.searchParams.get("limit"));
      sendJson(
        response,
        200,
        service.listEvents({ unackedOnly, afterSeq, limit }),
      );
      return;
    }

    if (parts.length === 3 && parts[2] === "ack" && request.method === "POST") {
      const body = parseBody(ackSchema, await readJson(request, maxBodyBytes));
      sendJson(response, 200, { acked: service.ackEvents(body.seqs) });
      return;
    }

    throw new AppError(`Route not found: ${request.method} ${url.pathname}`, "NOT_FOUND", 404);
  }

  return server;
}

function isAuthorized(request: http.IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

async function readJson(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new AppError("Request body is too large", "PAYLOAD_TOO_LARGE", 413);
    }
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("Request body must be valid JSON", "INVALID_JSON", 400);
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<body>"} ${issue.message}`)
      .join("; ");
    throw new AppError(`Invalid request body: ${message}`, "VALIDATION_ERROR", 400);
  }
  return parsed.data;
}

function parseStatus(value: string | null): (typeof TASK_STATUSES)[number] | undefined {
  if (!value) return undefined;
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new AppError(`Invalid task status: ${value}`, "VALIDATION_ERROR", 400);
  }
  return value as (typeof TASK_STATUSES)[number];
}

function parseLimit(value: string | null): number {
  if (!value) return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError("limit must be a positive integer", "VALIDATION_ERROR", 400);
  }
  return Math.min(parsed, 500);
}

function parseNonNegativeInt(value: string | null, label: string, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(`${label} must be a non-negative integer`, "VALIDATION_ERROR", 400);
  }
  return parsed;
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError("Invalid path parameter encoding", "VALIDATION_ERROR", 400);
  }
}

function sendError(response: http.ServerResponse, error: unknown, logger: Logger): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof AppError) {
    sendJson(response, error.status, errorBody(error.code, error.message));
    return;
  }
  logger.error("unhandled request error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  sendJson(response, 500, errorBody("INTERNAL_ERROR", "Internal server error"));
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}
