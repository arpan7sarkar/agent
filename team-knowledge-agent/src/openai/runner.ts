import crypto from "node:crypto";
import {
  recordAuditEvent,
  trackAgentRun,
  trackError,
  trackHandoff,
} from "../audit/audit-service.js";
import {
  parseApprovalMessageToRequest,
  runApprovalAgent,
} from "../agents/approval-agent.js";
import {
  parseIndexerMessageToRequest,
  runIndexerAgent,
} from "../agents/indexer-agent.js";
import { classifyRequest, summarizeHandoff, type RouterRoute } from "../agents/router-agent.js";
import { runQaAgent, type QaSourceReference } from "../agents/qa-agent.js";
import {
  parseStalenessMessageToRequest,
  runStalenessAgent,
} from "../agents/staleness-agent.js";
import { parseWriteMessageToRequest, runWriteAgent } from "../agents/write-agent.js";
import { withBindings } from "../config/logger.js";
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
  indexer: async ({ message, userId, correlationId }) => {
    const indexerRequest = parseIndexerMessageToRequest(userId, message);
    const indexerResult = await runIndexerAgent({
      ...indexerRequest,
      correlationId,
    });

    return {
      specialistOutput: indexerResult.summary,
    };
  },
  staleness: async ({ message, userId, correlationId }) => {
    const stalenessRequest = parseStalenessMessageToRequest(userId, message);
    const stalenessResult = await runStalenessAgent({
      ...stalenessRequest,
      correlationId,
    });
    return {
      specialistOutput: stalenessResult.summary,
    };
  },
  approval: async ({ message, userId, correlationId }) => {
    const approvalRequest = parseApprovalMessageToRequest(userId, message);
    const approvalResult = await runApprovalAgent({
      ...approvalRequest,
      correlationId,
    });
    return {
      specialistOutput: approvalResult.summary,
    };
  },
  write: async ({ message, userId, correlationId }) => {
    const writeRequest = parseWriteMessageToRequest(userId, message);
    const writeResult = await runWriteAgent({
      ...writeRequest,
      correlationId,
    });
    return {
      specialistOutput: writeResult.summary,
    };
  },
};

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

  await trackAgentRun({
    phase: "started",
    traceId,
    userId: request.userId,
    conversationId: request.conversationId,
    sessionId,
    details: {
      message: request.message,
    },
  });

  try {
    const decision = await classifyRequest(request.message);
    await recordAuditEvent({
      eventType: "route_selected",
      traceId,
      userId: request.userId,
      details: {
      route: decision.route,
      reason: decision.reason,
      modelRequestId: decision.modelRequestId,
      },
    });
    await trackHandoff({
      phase: "dispatched",
      traceId,
      userId: request.userId,
      route: decision.route,
      handoffReason: decision.reason,
      details: {
        conversationId: request.conversationId,
      },
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
    await trackHandoff({
      phase: "completed",
      traceId,
      userId: request.userId,
      route: decision.route,
      sourceReferenceCount: specialistResult.sourceReferences?.length ?? 0,
      details: {
        specialistOutputLength: specialistResult.specialistOutput.length,
      },
    });

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
    await trackAgentRun({
      phase: "completed",
      traceId,
      userId: request.userId,
      conversationId: request.conversationId,
      sessionId,
      route: decision.route,
      details: {
        sourceReferences: specialistResult.sourceReferences ?? [],
      },
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
    const message = error instanceof Error ? error.message : String(error);
    await trackAgentRun({
      phase: "failed",
      traceId,
      userId: request.userId,
      conversationId: request.conversationId,
      sessionId,
      error: message,
    });
    await trackError({
      traceId,
      userId: request.userId,
      scope: "openai.runner.runAgent",
      message,
      details: {
        sessionId,
      },
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

  await recordAuditEvent({
    eventType: "session_reset",
    traceId,
    userId,
    details: {
      conversationId,
      sessionId,
    },
  });

  return { sessionId, sessionState };
}
