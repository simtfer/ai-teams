import fs from "node:fs";
import path from "node:path";
import { ensureDirectory } from "./paths.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const value = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

export class Logger {
  private readonly minLevel = LEVEL_ORDER[configuredLevel()];

  constructor(
    private readonly scope: string,
    private readonly filePath?: string,
  ) {
    if (filePath) ensureDirectory(path.dirname(filePath));
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const suffix = meta === undefined ? "" : ` ${safeJson(meta)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${this.scope}] ${message}${suffix}`;
    process.stderr.write(`${line}\n`);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
      } catch (error) {
        process.stderr.write(`Logger file write failed: ${String(error)}\n`);
      }
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
