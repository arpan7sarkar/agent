import crypto from "node:crypto";
import { getEnv } from "./config/env.js";
import { closePostgres } from "./db/postgres.js";
import { runAgent } from "./openai/runner.js";
import { logger, newCorrelationId, withBindings } from "./config/logger.js";

function parseMessageFromArgs(): string {
  return process.argv.slice(2).join(" ").trim();
}

async function main(): Promise<void> {
  const env = getEnv();
  const correlationId = newCorrelationId();
  const log = withBindings({ correlationId });

  log.info(
    { port: env.PORT, openaiModel: env.OPENAI_MODEL },
    "Main agent runtime booted",
  );

  const message = parseMessageFromArgs();
  if (!message) {
    log.info(
      "Runtime is ready. Pass a message to run once, example: npm run dev -- \"How do we deploy?\"",
    );
    return;
  }

  const result = await runAgent({
    userId: process.env.DEMO_USER_ID ?? "00000000-0000-0000-0000-000000000001",
    conversationId:
      process.env.DEMO_CONVERSATION_ID ?? "00000000-0000-0000-0000-000000000001",
    message,
    requestId: crypto.randomUUID(),
    correlationId,
  });

  log.info(
    {
      traceId: result.traceId,
      sessionId: result.sessionId,
      route: result.route,
      response: result.response,
    },
    "Agent run result",
  );
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Runtime crashed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres();
  });
