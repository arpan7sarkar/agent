import { beforeEach, describe, expect, it, vi } from "vitest";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.CIVIC_TOKEN = "test-civic-token";
process.env.CIVIC_PROFILE_ID = "test-profile-id";
process.env.CIVIC_SLACK_WRITE_CHANNEL = "C-ALLOWED";
process.env.PINECONE_API_KEY = "test-pinecone-key";
process.env.PINECONE_INDEX = "test-pinecone-index";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.API_AUTH_TOKEN = "test-api-token";
const { getApprovalRequestByIdMock, trackWriteExecutionMock, trackErrorMock, trackToolCallMock } = vi.hoisted(() => ({
    getApprovalRequestByIdMock: vi.fn(),
    trackWriteExecutionMock: vi.fn(),
    trackErrorMock: vi.fn(),
    trackToolCallMock: vi.fn(),
}));
vi.mock("../../src/approvals/approval-store.js", () => ({
    getApprovalRequestById: getApprovalRequestByIdMock,
}));
vi.mock("../../src/audit/audit-service.js", () => ({
    trackWriteExecution: trackWriteExecutionMock,
    trackError: trackErrorMock,
    trackToolCall: trackToolCallMock,
}));
import { runWriteAgent } from "../../src/agents/write-agent.js";
function buildApprovalRecord(overrides = {}) {
    return {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "approved",
        actionType: "slack_write",
        payload: {
            tool_name: "slack.post_message",
            payload: {
                channel_id: "C-ALLOWED",
                text: "Approved message",
            },
        },
        requestedBy: "11111111-1111-4111-8111-111111111111",
        approvedBy: "22222222-2222-4222-8222-222222222222",
        createdAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        ...overrides,
    };
}
describe("Write Agent Approval Gates", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const action = {
        actionType: "slack_write",
        toolName: "slack.post_message",
        payload: {
            channel_id: "C-ALLOWED",
            text: "Approved message",
        },
    };
    beforeEach(() => {
        getApprovalRequestByIdMock.mockReset();
        trackWriteExecutionMock.mockReset();
        trackErrorMock.mockReset();
        trackToolCallMock.mockReset();
        trackWriteExecutionMock.mockResolvedValue("trace-1");
        trackErrorMock.mockResolvedValue("trace-1");
        trackToolCallMock.mockResolvedValue("trace-1");
    });
    it("blocks execution when approval is rejected", async () => {
        getApprovalRequestByIdMock.mockResolvedValue(buildApprovalRecord({ status: "rejected" }));
        const result = await runWriteAgent({
            userId,
            trigger: "cli",
            approvalRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            action,
        });
        expect(result.executed).toBe(false);
        expect(result.status).toBe("blocked");
        expect(result.summary).toContain("rejected");
    });
    it("blocks execution when approval timed out", async () => {
        const expiredAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
        getApprovalRequestByIdMock.mockResolvedValue(buildApprovalRecord({ status: "approved", resolvedAt: expiredAt }));
        const result = await runWriteAgent({
            userId,
            trigger: "cli",
            approvalRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            action,
        });
        expect(result.executed).toBe(false);
        expect(result.status).toBe("blocked");
        expect(result.summary).toContain("expired by TTL");
    });
    it("executes writes only after valid approval", async () => {
        const noApprovalResult = await runWriteAgent({
            userId,
            trigger: "cli",
            action,
        });
        expect(noApprovalResult.executed).toBe(false);
        expect(noApprovalResult.status).toBe("blocked");
        expect(noApprovalResult.summary).toContain("Missing approval request ID");
        expect(getApprovalRequestByIdMock).not.toHaveBeenCalled();
        getApprovalRequestByIdMock.mockResolvedValue(buildApprovalRecord({ status: "approved", resolvedAt: new Date().toISOString() }));
        const approvedResult = await runWriteAgent({
            userId,
            trigger: "cli",
            approvalRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            action,
        });
        expect(approvedResult.executed).toBe(true);
        expect(approvedResult.status).toBe("executed");
        expect(approvedResult.summary).toContain("Write executed with approval");
        expect(approvedResult.toolName).toBe("slack.post_message");
    });
});
//# sourceMappingURL=write-agent-approval-gates.test.js.map