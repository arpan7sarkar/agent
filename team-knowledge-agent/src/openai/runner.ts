import crypto from "node:crypto";
import { classifyRequest, summarizeHandoff, type RouterRoute } from "../agents/router-agent.js";
import { withBindings } from "../config/logger.js";
import { query, withTransaction } from "../db/postgres.js";

export type AgentRequest = {
  userId: string;
  conversationId: string;
  message: string;
  requestId?: string;
  correlationId?: string;
};

type SessionRow = {
  id: string;
  state_json: SessionState;
};

type SessionTurn = {
  at: string;
  route: RouterRoute;
  userMessage: string;
  agentResponse: string;
};

type SessionState = {
  lastRoute?: RouterRoute;
  lastUserMessage?: string;
  lastAgentResponse?: string;
  turns?: SessionTurn[];
};

export type AgentRunResult = {
  traceId: string;
  sessionId: string;
  route: RouterRoute;
  response: string;
  specialistOutput: string;
};

type SpecialistContext = {
  message: string;
  sessionState: SessionState;
};

type SpecialistHandler = (context: SpecialistContext) => Promise<string>;

const specialistHandlers: Record<RouterRoute, SpecialistHandler> = {
  qa: async ({ message }) =>
    `QA specialist placeholder: received question "${message}". Retrieval flow will be added in later steps.`,
  indexer: async () =>
    "Indexer specialist placeholder: indexing pipeline is not wired yet, but routing is functioning.",
  staleness: async () =>
    "Staleness specialist placeholder: stale-doc analysis flow will be added in later steps.",
  approval: async () =>
    "Approval specialist placeholder: durable approval flow will be added in later steps.",
  write: async () =>
    "Write specialist placeholder: write execution is blocked until approval flow is implemented.",
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

function firstRowOrThrow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function ensureUserAndConversation(userId: string, conversationId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO users (id)
        VALUES ($1::uuid)
        ON CONFLICT (id) DO NOTHING
      `,
      [userId],
    );

    await client.query(
      `
        INSERT INTO conversations (id, user_id)
        VALUES ($1::uuid, $2::uuid)
        ON CONFLICT (id) DO UPDATE
        SET user_id = EXCLUDED.user_id, updated_at = NOW()
      `,
      [conversationId, userId],
    );
  });
}

async function loadOrCreateSession(
  userId: string,
  conversationId: string,
): Promise<{ sessionId: string; sessionState: SessionState }> {
  const existing = await query<SessionRow>(
    `
      SELECT id, state_json
      FROM sessions
      WHERE user_id = $1::uuid AND conversation_id = $2::uuid
      LIMIT 1
    `,
    [userId, conversationId],
  );

  if (existing.rows.length > 0) {
    const row = firstRowOrThrow(existing.rows, "Expected existing session row");
    return {
      sessionId: row.id,
      sessionState: row.state_json ?? {},
    };
  }

  const created = await query<SessionRow>(
    `
      INSERT INTO sessions (user_id, conversation_id, state_json, updated_at)
      VALUES ($1::uuid, $2::uuid, '{}'::jsonb, NOW())
      RETURNING id, state_json
    `,
    [userId, conversationId],
  );

  const row = firstRowOrThrow(created.rows, "Failed to create session row");
  return { sessionId: row.id, sessionState: row.state_json ?? {} };
}

async function saveSession(
  sessionId: string,
  sessionState: SessionState,
): Promise<void> {
  await query(
    `
      UPDATE sessions
      SET state_json = $2::jsonb,
          updated_at = NOW()
      WHERE id = $1::uuid
    `,
    [sessionId, JSON.stringify(sessionState)],
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

  await ensureUserAndConversation(request.userId, request.conversationId);
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
    const specialistOutput = await specialist({
      message: request.message,
      sessionState,
    });

    const response = await summarizeHandoff(decision.route, specialistOutput);

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

    await saveSession(sessionId, nextState);
    await appendAuditEvent("run_completed", traceId, request.userId, {
      sessionId,
      route: decision.route,
    });

    log.info({ sessionId, route: decision.route }, "Agent run completed");

    return {
      traceId,
      sessionId,
      route: decision.route,
      response,
      specialistOutput,
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
