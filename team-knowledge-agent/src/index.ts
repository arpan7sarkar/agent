import type { Server } from "node:http";
import { startApiServer } from "./api/server.js";
import { getEnv } from "./config/env.js";
import { closePostgres } from "./db/postgres.js";
import { logger, newCorrelationId, withBindings } from "./config/logger.js";
import { getCivicClient } from "./civic/client.js";

async function main(): Promise<void> {
  const env = getEnv();
  const correlationId = newCorrelationId();
  const log = withBindings({ correlationId });
  const civicClient = getCivicClient();
  let server: Server | null = null;

  log.info(
    { port: env.PORT, openaiModel: env.OPENAI_MODEL },
    "Main agent runtime booted",
  );
  log.info(civicClient.getRuntimeInfo(), "Civic MCP integration initialized");
  const started = await startApiServer();
  server = started.server;

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down runtime");
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      server = null;
    }
    await closePostgres();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Runtime crashed");
    process.exitCode = 1;
  })
  .finally(async () => {
    // Keep process alive while API server is running.
  });
