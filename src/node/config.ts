import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../shared/errors.js";
import { ensureDirectory, resolveConfigPath, resolveRelativeToConfig } from "../shared/paths.js";

const harnessConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    version: z.string().min(1).optional(),
  })
  .strict();

const nodeConfigSchema = z
  .object({
    nodeId: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    host: z.string().min(1).default("0.0.0.0"),
    port: z.number().int().min(1).max(65535),
    token: z.string().min(8).optional(),
    tokenEnv: z.string().min(1).optional(),
    dataDir: z.string().min(1).default("./data"),
    allowedRoots: z.array(z.string().min(1)).min(1),
    harnesses: z
      .object({
        pi: harnessConfigSchema,
      })
      .default({ pi: { command: "pi", args: [] } }),
    appendSystemPrompt: z.string().optional(),
    maxPromptChars: z.number().int().min(1).default(200_000),
    version: z.string().min(1).default("0.1.0"),
  })
  .strict();

export type NodeConfig = z.infer<typeof nodeConfigSchema>;
export type PiHarnessConfig = z.infer<typeof harnessConfigSchema>;

export interface LoadedNodeConfig {
  config: NodeConfig;
  configPath: string;
  dataDir: string;
  dbPath: string;
  logDir: string;
  token: string;
  allowedRoots: string[];
}

export function loadNodeConfig(explicitPath?: string): LoadedNodeConfig {
  const configPath = resolveConfigPath(
    explicitPath,
    process.env.AI_TEAMS_NODE_CONFIG,
    "config/node.json",
  );

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new AppError(
      `Failed to read node config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "CONFIG_INVALID",
      1,
      error,
    );
  }

  const parsed = nodeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      `Invalid node config ${configPath}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
        .join("; ")}`,
      "CONFIG_INVALID",
      1,
    );
  }

  const config = parsed.data;
  const token = resolveToken(config, configPath);
  const dataDir = resolveRelativeToConfig(configPath, config.dataDir);
  const logDir = path.join(dataDir, "logs");
  ensureDirectory(dataDir);
  ensureDirectory(logDir);

  return {
    config,
    configPath,
    dataDir,
    dbPath: path.join(dataDir, "node.db"),
    logDir,
    token,
    allowedRoots: config.allowedRoots.map((root) => resolveRelativeToConfig(configPath, root)),
  };
}

function resolveToken(config: NodeConfig, configPath: string): string {
  let token: string | undefined;
  if (config.tokenEnv) {
    token = process.env[config.tokenEnv];
    if (!token) {
      throw new AppError(
        `Node config ${configPath} references missing environment variable ${config.tokenEnv}`,
        "CONFIG_INVALID",
        1,
      );
    }
  } else {
    token = process.env.AI_TEAMS_NODE_TOKEN ?? config.token;
  }

  if (!token || token.length < 8) {
    throw new AppError(
      "Node token is required and must be at least 8 characters. Set token/tokenEnv in the config or AI_TEAMS_NODE_TOKEN.",
      "CONFIG_INVALID",
      1,
    );
  }
  return token;
}
