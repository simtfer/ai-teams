import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../shared/errors.js";
import { ensureDirectory, resolveConfigPath, resolveRelativeToConfig } from "../shared/paths.js";

const supervisorNodeSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    baseUrl: z.string().min(1),
    token: z.string().min(8).optional(),
    tokenEnv: z.string().min(1).optional(),
  })
  .strict();

const supervisorConfigSchema = z
  .object({
    dataDir: z.string().min(1).default("./data"),
    requestTimeoutMs: z.number().int().min(1000).max(300_000).default(15_000),
    nodes: z.array(supervisorNodeSchema).min(1),
  })
  .strict();

export type SupervisorConfig = z.infer<typeof supervisorConfigSchema>;
export type SupervisorNodeConfig = z.infer<typeof supervisorNodeSchema>;

export interface ResolvedNodeConfig {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
}

export interface LoadedSupervisorConfig {
  config: SupervisorConfig;
  configPath: string;
  dataDir: string;
  dbPath: string;
  logDir: string;
  nodes: ResolvedNodeConfig[];
  requestTimeoutMs: number;
}

export function loadSupervisorConfig(explicitPath?: string): LoadedSupervisorConfig {
  const configPath = resolveConfigPath(
    explicitPath,
    process.env.AI_TEAMS_SUPERVISOR_CONFIG,
    "config/supervisor.json",
  );

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new AppError(
      `Failed to read supervisor config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "CONFIG_INVALID",
      1,
      error,
    );
  }

  const parsed = supervisorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      `Invalid supervisor config ${configPath}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
        .join("; ")}`,
      "CONFIG_INVALID",
      1,
    );
  }

  const config = parsed.data;
  const ids = new Set<string>();
  const nodes = config.nodes.map((node) => {
    if (ids.has(node.id)) {
      throw new AppError(`Duplicate node id in config: ${node.id}`, "CONFIG_INVALID", 1);
    }
    ids.add(node.id);
    return {
      id: node.id,
      name: node.name,
      baseUrl: normalizeBaseUrl(node.baseUrl, node.id),
      token: resolveNodeToken(node, configPath),
    };
  });

  const dataDir = resolveRelativeToConfig(configPath, config.dataDir);
  const logDir = path.join(dataDir, "logs");
  ensureDirectory(dataDir);
  ensureDirectory(logDir);

  return {
    config,
    configPath,
    dataDir,
    dbPath: path.join(dataDir, "supervisor.db"),
    logDir,
    nodes,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

function resolveNodeToken(node: SupervisorNodeConfig, configPath: string): string {
  let token: string | undefined;
  if (node.tokenEnv) {
    token = process.env[node.tokenEnv];
    if (!token) {
      throw new AppError(
        `Node ${node.id} references missing environment variable ${node.tokenEnv} in ${configPath}`,
        "CONFIG_INVALID",
        1,
      );
    }
  } else {
    token = node.token;
  }
  if (!token || token.length < 8) {
    throw new AppError(
      `Node ${node.id} requires a token of at least 8 characters`,
      "CONFIG_INVALID",
      1,
    );
  }
  return token;
}

function normalizeBaseUrl(value: string, nodeId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(`Node ${nodeId} has invalid baseUrl: ${value}`, "CONFIG_INVALID", 1);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      `Node ${nodeId} baseUrl must use http or https: ${value}`,
      "CONFIG_INVALID",
      1,
    );
  }
  return url.toString().replace(/\/+$/, "");
}
