import { logger } from "../config/logger.js";
import { closePostgres } from "./postgres.js";
import { initBaseSchema } from "./schema.js";

async function main(): Promise<void> {
  await initBaseSchema();
  logger.info("Postgres base schema initialized");
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Failed to initialize Postgres base schema");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres();
  });

