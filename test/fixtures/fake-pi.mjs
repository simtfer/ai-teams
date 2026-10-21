#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("1.3.0\n", () => process.exit(0));
}

const sessionIndex = args.indexOf("--session-id");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "unknown";
const stateDir =
  process.env.AI_TEAMS_FAKE_PI_STATE || path.join(process.cwd(), ".fake-pi-state");
fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });

const prompt = fs.readFileSync(0, "utf8");
const sessionFile = path.join(stateDir, "sessions", `${sessionId}.jsonl`);
fs.appendFileSync(sessionFile, `${JSON.stringify({ prompt })}\n`);
fs.appendFileSync(
  path.join(stateDir, "runs.jsonl"),
  `${JSON.stringify({ sessionId, cwd: process.cwd(), prompt, at: Date.now() })}\n`,
);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function finish(text) {
  emit({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  emit({ type: "agent_end", messages: [] });
  process.stdout.write("", () => process.exit(0));
}

emit({ type: "session", version: 3, id: sessionId, cwd: process.cwd() });
emit({ type: "agent_start" });
emit({ type: "turn_start" });

if (prompt.includes("MODE:needs_input")) {
  finish("NEEDS_INPUT: Which environment should I target?");
} else if (prompt.includes("MODE:fail")) {
  process.stderr.write("fake pi exploded: simulated failure\n", () => process.exit(2));
  setTimeout(() => process.exit(2), 1000);
} else if (prompt.includes("MODE:slow")) {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  fs.writeFileSync(path.join(stateDir, "grandchild.pid"), String(grandchild.pid));
  setTimeout(() => finish("SLOW-DONE"), 60_000);
} else if (prompt.includes("MODE:recall")) {
  const lines = fs
    .readFileSync(sessionFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  finish(`RECALL:${lines.map((entry) => entry.prompt).join(" | ")}`);
} else if (prompt.includes("MODE:remember:")) {
  const token = prompt.split("MODE:remember:")[1].trim().split(/\s/)[0];
  finish(`STORED:${token}`);
} else if (prompt.includes("MODE:long")) {
  finish(`LONG:${"x".repeat(120_000)}`);
} else if (prompt.includes("MODE:echo")) {
  finish(`ECHO:${prompt.replace(/\s+/g, " ").slice(0, 1000)}`);
} else {
  finish("DONE");
}
