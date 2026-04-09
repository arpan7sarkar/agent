import { beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock, withTransactionMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    withTransactionMock: vi.fn(),
}));
vi.mock("../../src/db/postgres.js", () => ({
    query: queryMock,
    withTransaction: withTransactionMock,
}));
import { loadOrCreateSession, saveSessionState } from "../../src/sessions/session-store.js";
describe("Session Store Isolation", () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    const conversation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversations = new Map();
    const sessions = new Map();
    let sessionCounter = 0;
    beforeEach(() => {
        conversations.clear();
        sessions.clear();
        sessionCounter = 0;
        queryMock.mockReset();
        withTransactionMock.mockReset();
        withTransactionMock.mockImplementation(async (work) => {
            const clientQuery = vi.fn(async (sql, values = []) => {
                const normalized = sql.replace(/\s+/g, " ").toLowerCase();
                if (normalized.includes("insert into users")) {
                    return { rows: [], rowCount: 1 };
                }
                if (normalized.includes("select user_id") && normalized.includes("from conversations")) {
                    const conversationId = String(values[0]);
                    const owner = conversations.get(conversationId);
                    return {
                        rows: owner ? [{ user_id: owner }] : [],
                        rowCount: owner ? 1 : 0,
                    };
                }
                if (normalized.includes("insert into conversations")) {
                    const conversationId = String(values[0]);
                    const owner = String(values[1]);
                    conversations.set(conversationId, owner);
                    return { rows: [], rowCount: 1 };
                }
                throw new Error(`Unexpected transaction query in test: ${normalized}`);
            });
            return work({ query: clientQuery });
        });
        queryMock.mockImplementation(async (sql, values = []) => {
            const normalized = sql.replace(/\s+/g, " ").toLowerCase();
            if (normalized.includes("insert into sessions")) {
                const userId = String(values[0]);
                const conversationId = String(values[1]);
                const key = `${userId}:${conversationId}`;
                let session = sessions.get(key);
                if (!session) {
                    sessionCounter += 1;
                    session = {
                        id: `session-${sessionCounter}`,
                        userId,
                        conversationId,
                        stateJson: {},
                    };
                    sessions.set(key, session);
                }
                return {
                    rows: [{ id: session.id, state_json: session.stateJson }],
                    rowCount: 1,
                };
            }
            if (normalized.includes("update sessions")) {
                const sessionId = String(values[0]);
                const userId = String(values[1]);
                const conversationId = String(values[2]);
                const nextState = JSON.parse(String(values[3]));
                const key = `${userId}:${conversationId}`;
                const session = sessions.get(key);
                if (!session || session.id !== sessionId) {
                    return { rows: [], rowCount: 0 };
                }
                session.stateJson = nextState;
                sessions.set(key, session);
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected query in test: ${normalized}`);
        });
    });
    it("blocks loading the same conversation from a different user", async () => {
        await loadOrCreateSession(userA, conversation);
        await expect(loadOrCreateSession(userB, conversation)).rejects.toThrow("Conversation does not belong to the requested user.");
    });
    it("blocks state writes when user/session scope mismatches", async () => {
        const { sessionId } = await loadOrCreateSession(userA, conversation);
        await expect(saveSessionState(userB, conversation, sessionId, { lastRoute: "qa" })).rejects.toThrow("Session update blocked: user/session scope mismatch.");
    });
});
//# sourceMappingURL=session-isolation.test.js.map