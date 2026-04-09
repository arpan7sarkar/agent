import { getEnv } from "./config/env.js";
import { logger, newCorrelationId, withBindings } from "./config/logger.js";

// Step 2 scaffold: validate env + structured logging.
// Later steps will replace this with the API server bootstrap.
const env = getEnv();
const correlationId = newCorrelationId();
const log = withBindings({ correlationId });

log.info(
  { port: env.PORT, openaiModel: env.OPENAI_MODEL },
  "team-knowledge-agent: scaffold OK",
);

// Keep the base logger referenced so future modules can import it consistently.
void logger;
