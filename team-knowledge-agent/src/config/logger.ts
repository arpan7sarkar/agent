import crypto from "node:crypto";
import pino from "pino";

export type LogBindings = {
  requestId?: string;
  correlationId?: string;
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "team-knowledge-agent",
  },
  redact: {
    // Avoid accidentally logging secrets if they end up in payloads.
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "authorization",
      "OPENAI_API_KEY",
      "CIVIC_TOKEN",
      "PINECONE_API_KEY",
      "DATABASE_URL",
    ],
    remove: true,
  },
});

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function withBindings(bindings: LogBindings) {
  return logger.child(bindings);
}

