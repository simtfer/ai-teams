import path from "node:path";
import { Logger } from "../shared/logger.js";
import { loadNodeConfig } from "./config.js";
import { NodeStore } from "./db.js";
import { createNodeServer } from "./server.js";
import { NodeService } from "./service.js";

async function main(): Promise<void> {
  const configArg = readConfigArg(process.argv.slice(2));
  const loaded = loadNodeConfig(configArg);
  const logger = new Logger("node", path.join(loaded.logDir, "node.log"));
  const store = new NodeStore(loaded.dbPath);
  const service = new NodeService({
    config: loaded.config,
    allowedRoots: loaded.allowedRoots,
    logDir: loaded.logDir,
    store,
    logger,
  });

  await service.start();

  const server = createNodeServer({
    service,
    token: loaded.token,
    logger,
    maxPromptChars: loaded.config.maxPromptChars,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(loaded.config.port, loaded.config.host, resolve);
  });

  logger.info("node agent listening", {
    nodeId: loaded.config.nodeId,
    address: `${loaded.config.host}:${loaded.config.port}`,
    config: loaded.configPath,
    dataDir: loaded.dataDir,
  });

  let stopping = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { reason });
    const forceExit = setTimeout(() => process.exit(exitCode), 10_000);
    forceExit.unref();

    server.close();
    server.closeAllConnections();
    try {
      await service.shutdown();
      store.close();
    } catch (error) {
      logger.error("shutdown failed", {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error: error.stack ?? error.message });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { reason: String(reason) });
  });
}

function readConfigArg(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") return argv[index + 1];
    if (value.startsWith("--config=")) return value.slice("--config=".length);
  }
  return undefined;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to start node agent: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
