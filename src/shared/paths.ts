import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";

export function findProjectRoot(fromFileUrl: string = import.meta.url): string {
  let current = path.dirname(fileURLToPath(fromFileUrl));
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export function resolveConfigPath(
  explicitPath: string | undefined,
  envValue: string | undefined,
  defaultRelativePath: string,
): string {
  const candidates: string[] = [];
  if (explicitPath) {
    candidates.push(path.resolve(process.cwd(), explicitPath));
  } else if (envValue) {
    candidates.push(path.resolve(process.cwd(), envValue));
  }
  const root = findProjectRoot();
  candidates.push(path.resolve(root, defaultRelativePath));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new AppError(
    `Config file not found. Looked in: ${candidates.join(", ")}`,
    "CONFIG_NOT_FOUND",
    1,
  );
}

export function resolveRelativeToConfig(configPath: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.resolve(path.dirname(configPath), targetPath);
}

export function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

export function normalizeExistingDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    throw new AppError(`Directory does not exist: ${directory}`, "DIRECTORY_NOT_FOUND", 400);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new AppError(`Path is not a directory: ${directory}`, "NOT_A_DIRECTORY", 400);
  }
  return real;
}

export function pathKey(directory: string): string {
  const normalized = path.normalize(directory);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const parentKey = pathKey(parent);
  const candidateKey = pathKey(candidate);
  const relative = path.relative(parentKey, candidateKey);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveAllowedCwd(cwd: string, allowedRoots: string[]): string {
  if (!path.isAbsolute(cwd)) {
    throw new AppError("Working directory must be an absolute path", "CWD_NOT_ABSOLUTE", 400);
  }
  const realCwd = normalizeExistingDirectory(cwd);
  const realRoots = allowedRoots.map((root) => normalizeExistingDirectory(root));
  if (!realRoots.some((root) => isPathInside(root, realCwd))) {
    throw new AppError(
      `Working directory is outside allowed roots: ${cwd}`,
      "CWD_OUTSIDE_ALLOWED_ROOTS",
      400,
    );
  }
  return realCwd;
}
