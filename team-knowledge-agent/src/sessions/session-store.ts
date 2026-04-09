import { query, withTransaction } from "../db/postgres.js";

export type SessionTurn = {
  at: string;
  route: string;
  userMessage: string;
  agentResponse: string;
};

export type SessionState = {
  lastRoute?: string;
  lastUserMessage?: string;
  lastAgentResponse?: string;
  turns?: SessionTurn[];
};

type SessionRow = {
  id: string;
  state_json: SessionState;
};

type ConversationOwnerRow = {
  user_id: string;
};

function firstRowOrThrow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function ensureConversationOwnership(
  userId: string,
  conversationId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO users (id)
        VALUES ($1::uuid)
        ON CONFLICT (id) DO NOTHING
      `,
      [userId],
    );

    const conversation = await client.query<ConversationOwnerRow>(
      `
        SELECT user_id
        FROM conversations
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [conversationId],
    );

    if (conversation.rows.length === 0) {
      await client.query(
        `
          INSERT INTO conversations (id, user_id)
          VALUES ($1::uuid, $2::uuid)
        `,
        [conversationId, userId],
      );
      return;
    }

    const row = firstRowOrThrow(conversation.rows, "Conversation row not found");
    if (row.user_id !== userId) {
      throw new Error("Conversation does not belong to the requested user.");
    }
  });
}

export async function loadSession(
  userId: string,
  conversationId: string,
): Promise<{ sessionId: string; sessionState: SessionState } | null> {
  const result = await query<SessionRow>(
    `
      SELECT id, state_json
      FROM sessions
      WHERE user_id = $1::uuid AND conversation_id = $2::uuid
      LIMIT 1
    `,
    [userId, conversationId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = firstRowOrThrow(result.rows, "Session row not found");
  return {
    sessionId: row.id,
    sessionState: row.state_json ?? {},
  };
}

export async function loadOrCreateSession(
  userId: string,
  conversationId: string,
): Promise<{ sessionId: string; sessionState: SessionState }> {
  await ensureConversationOwnership(userId, conversationId);

  const createdOrExisting = await query<SessionRow>(
    `
      INSERT INTO sessions (user_id, conversation_id, state_json, updated_at)
      VALUES ($1::uuid, $2::uuid, '{}'::jsonb, NOW())
      ON CONFLICT (user_id, conversation_id)
      DO UPDATE SET updated_at = NOW()
      RETURNING id, state_json
    `,
    [userId, conversationId],
  );

  const row = firstRowOrThrow(
    createdOrExisting.rows,
    "Failed to load or create session row",
  );
  return {
    sessionId: row.id,
    sessionState: row.state_json ?? {},
  };
}

export async function saveSessionState(
  userId: string,
  conversationId: string,
  sessionId: string,
  sessionState: SessionState,
): Promise<void> {
  const result = await query(
    `
      UPDATE sessions
      SET state_json = $4::jsonb,
          updated_at = NOW()
      WHERE id = $1::uuid
        AND user_id = $2::uuid
        AND conversation_id = $3::uuid
    `,
    [sessionId, userId, conversationId, JSON.stringify(sessionState)],
  );

  if (result.rowCount === 0) {
    throw new Error("Session update blocked: user/session scope mismatch.");
  }
}

export async function resetSessionState(
  userId: string,
  conversationId: string,
): Promise<{ sessionId: string; sessionState: SessionState }> {
  const { sessionId } = await loadOrCreateSession(userId, conversationId);
  const clearedState: SessionState = {};

  await saveSessionState(userId, conversationId, sessionId, clearedState);
  return { sessionId, sessionState: clearedState };
}

