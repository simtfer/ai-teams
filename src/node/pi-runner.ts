import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { ensureDirectory } from "../shared/paths.js";

export interface PiRunOptions {
  command: string;
  baseArgs: string[];
  cwd: string;
  sessionId: string;
  prompt: string;
  appendSystemPrompt?: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface PiRunResult {
  text: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  stderrTail: string;
}

export interface PiRun {
  readonly pid: number | undefined;
  readonly result: Promise<PiRunResult>;
  kill(): void;
}

interface JsonEvent {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

const STDERR_TAIL_LIMIT = 8000;

export function startPiRun(options: PiRunOptions): PiRun {
  ensureDirectory(path.dirname(options.stdoutLogPath));
  ensureDirectory(path.dirname(options.stderrLogPath));

  const stdoutLog = fs.createWriteStream(options.stdoutLogPath, { flags: "a" });
  const stderrLog = fs.createWriteStream(options.stderrLogPath, { flags: "a" });

  const args = [
    ...options.baseArgs,
    "-p",
    "--mode",
    "json",
    "--session-id",
    options.sessionId,
    "--approve",
  ];
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  let child: ChildProcess;
  try {
    child = crossSpawn(options.command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: process.env,
    });
  } catch (error) {
    stdoutLog.end();
    stderrLog.end();
    return {
      pid: undefined,
      result: Promise.resolve({
        text: "",
        exitCode: null,
        signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
        stderrTail: "",
      }),
      kill() {},
    };
  }

  let finalText = "";
  let stderrTail = "";
  let spawnError: string | null = null;
  let settled = false;
  let stdoutBuffer = "";
  let killRequested = false;

  const resolveOnce = (
    resolve: (value: PiRunResult) => void,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    if (settled) return;
    settled = true;
    if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
    stdoutLog.end();
    stderrLog.end();
    resolve({ text: finalText, exitCode, signal, spawnError, stderrTail });
  };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: JsonEvent;
    try {
      event = JSON.parse(trimmed) as JsonEvent;
    } catch {
      return;
    }
    if (event.type !== "turn_end") return;
    if (event.message?.role !== "assistant") return;
    const text = extractText(event.message.content);
    if (text.trim()) finalText = text;
  };

  const result = new Promise<PiRunResult>((resolve) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutLog.write(text);
      stdoutBuffer += text;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrLog.write(text);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    });

    child.on("error", (error) => {
      spawnError = error.message;
      resolveOnce(resolve, null, null);
    });

    child.on("close", (code, signal) => {
      resolveOnce(resolve, code, signal);
    });

    child.stdin?.on("error", () => {
      // The child may exit before consuming stdin; the close event carries the outcome.
    });
    child.stdin?.end(options.prompt, "utf8");
  });

  return {
    pid: child.pid,
    result,
    kill() {
      if (killRequested || settled) return;
      killRequested = true;
      killProcessTree(child);
    },
  };
}

export async function readHarnessVersion(
  command: string,
  baseArgs: string[],
  timeoutMs = 10_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let child: ChildProcess;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (child?.pid) killProcessTree(child);
      finish(null);
    }, timeoutMs);

    try {
      child = crossSpawn(command, [...baseArgs, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    } catch {
      finish(null);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      const match = output.match(/\d+\.\d+\.\d+[^\s]*/);
      finish(match ? match[0] : output.trim().split(/\r?\n/)[0] || null);
    });
  });
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push(candidate.text);
    }
  }
  return parts.join("\n");
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = crossSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const forceTimer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }, 5000);
  forceTimer.unref();
}
