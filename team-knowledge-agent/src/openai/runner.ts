import crypto from "node:crypto";
import { classifyRequest, summarizeHandoff, type RouterRoute } from "../agents/router-agent.js";
import { runQaAgent, type QaSourceReference } from "../agents/qa-agent.js";
import { withBindings } from "../config/logger.js";
import { query } from "../db/postgres.js";
import {
  loadOrCreateSession,
  resetSessionState,
  saveSessionState,
  type SessionState,
} from "../sessions/session-store.js";

export type AgentRequest = {
  userId: string;
  conversationId: string;
  message: string;
  requestId?: string;
  correlationId?: string;
};

export type AgentRunResult = {
  traceId: string;
  sessionId: string;
  route: RouterRoute;
  response: string;
  specialistOutput: string;
};

type SpecialistContext = {
  userId: string;
  conversationId: string;
  correlationId: string;
  message: string;
  sessionState: SessionState;
};

type SpecialistResult = {
  specialistOutput: string;
  skipRouterSummary?: boolean;
  sourceReferences?: QaSourceReference[];
};

type SpecialistHandler = (context: SpecialistContext) => Promise<SpecialistResult>;

const specialistHandlers: Record<RouterRoute, SpecialistHandler> = {
  qa: async ({ message, userId, correlationId }) => {
    const qaResult = await runQaAgent({
      userId,
      question: message,
      correlationId,
    });
    return {
      specialistOutput: qaResult.answer,
      skipRouterSummary: true,
      sourceReferences: qaResult.sourceReferences,
    };
  },
  indexer: async () =>
    ({
      specialistOutput:
        "Indexer specialist placeholder: indexing pipeline is not wired yet, but routing is functioning.",
    }),
  staleness: async () =>
    ({
      specialistOutput:
        "Staleness specialist placeholder: stale-doc analysis flow will be added in later steps.",
    }),
  approval: async () =>
    ({
      specialistOutput:
        "Approval specialist placeholder: durable approval flow will be added in later steps.",
    }),
  write: async () =>
    ({
      specialistOutput:
        "Write specialist placeholder: write execution is blocked until approval flow is implemented.",
    }),
};

async function appendAuditEvent(
  eventType: string,
  traceId: string,
  userId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await query(
    `
      INSERT INTO audit_events (event_type, trace_id, user_id, details_json)
      VALUES ($1, $2, $3::uuid, $4::jsonb)
    `,
    [eventType, traceId, userId, JSON.stringify(details)],
  );
}

export async function runAgent(request: AgentRequest): Promise<AgentRunResult> {
  const traceId = request.correlationId ?? crypto.randomUUID();
  const requestId = request.requestId ?? crypto.randomUUID();
  const log = withBindings({ correlationId: traceId, requestId });

  log.info(
    {
      userId: request.userId,
      conversationId: request.conversationId,
    },
    "Agent run started",
  );

  const { sessionId, sessionState } = await loadOrCreateSession(
    request.userId,
    request.conversationId,
  );

  await appendAuditEvent("run_started", traceId, request.userId, {
    conversationId: request.conversationId,
    sessionId,
    message: request.message,
  });

  try {
    const decision = await classifyRequest(request.message);
    await appendAuditEvent("route_selected", traceId, request.userId, {
      route: decision.route,
      reason: decision.reason,
      modelRequestId: decision.modelRequestId,
    });

    const specialist = specialistHandlers[decision.route];
    const specialistResult = await specialist({
      userId: request.userId,
      conversationId: request.conversationId,
      correlationId: traceId,
      message: request.message,
      sessionState,
    });

    const response = specialistResult.skipRouterSummary
      ? specialistResult.specialistOutput
      : await summarizeHandoff(decision.route, specialistResult.specialistOutput);

    const turns = Array.isArray(sessionState.turns) ? sessionState.turns : [];
    const nextState: SessionState = {
      ...sessionState,
      lastRoute: decision.route,
      lastUserMessage: request.message,
      lastAgentResponse: response,
      turns: [
        ...turns,
        {
          at: new Date().toISOString(),
          route: decision.route,
          userMessage: request.message,
          agentResponse: response,
        },
      ].slice(-20),
    };

    await saveSessionState(
      request.userId,
      request.conversationId,
      sessionId,
      nextState,
    );
    await appendAuditEvent("run_completed", traceId, request.userId, {
      sessionId,
      route: decision.route,
      sourceReferences: specialistResult.sourceReferences ?? [],
    });

    log.info(
      {
        sessionId,
        route: decision.route,
        sourceReferenceCount: specialistResult.sourceReferences?.length ?? 0,
      },
      "Agent run completed",
    );

    return {
      traceId,
      sessionId,
      route: decision.route,
      response,
      specialistOutput: specialistResult.specialistOutput,
    };
  } catch (error) {
    await appendAuditEvent("run_failed", traceId, request.userId, {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    log.error({ err: error, sessionId }, "Agent run failed");
    throw error;
  }
}

export async function resetAgentSession(
  userId: string,
  conversationId: string,
): Promise<{ sessionId: string; sessionState: SessionState }> {
  const { sessionId, sessionState } = await resetSessionState(userId, conversationId);
  const traceId = crypto.randomUUID();

  await appendAuditEvent("session_reset", traceId, userId, {
    conversationId,
    sessionId,
  });

  return { sessionId, sessionState };
}
