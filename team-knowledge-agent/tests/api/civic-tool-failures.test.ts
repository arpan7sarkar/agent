import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OPENAI_API_KEY = "test-openai-key";
process.env.CIVIC_TOKEN = "test-civic-token";
process.env.CIVIC_PROFILE_ID = "test-profile-id";
process.env.CIVIC_SLACK_WRITE_CHANNEL = "C-ALLOWED";
process.env.PINECONE_API_KEY = "test-pinecone-key";
process.env.PINECONE_INDEX = "test-pinecone-index";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.API_AUTH_TOKEN = "test-api-token";

const { getApprovalRequestByIdMock, trackWriteExecutionMock, trackErrorMock, trackToolCallMock } =
  vi.hoisted(() => ({
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

describe("Civic Tool Failure Handling", () => {
  beforeEach(() => {
    getApprovalRequestByIdMock.mockReset();
    trackWriteExecutionMock.mockReset();
    trackErrorMock.mockReset();
    trackToolCallMock.mockReset();
    trackWriteExecutionMock.mockResolvedValue("trace-1");
    trackErrorMock.mockResolvedValue("trace-1");
    trackToolCallMock.mockResolvedValue("trace-1");
  });

  it("returns blocked status when Civic tool invocation fails", async () => {
    getApprovalRequestByIdMock.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "approved",
      actionType: "slack_write",
      payload: {
        tool_name: "slack.post_message",
        payload: {
          channel_id: "C-DENIED",
          text: "Safe write",
        },
      },
      requestedBy: "11111111-1111-4111-8111-111111111111",
      approvedBy: "22222222-2222-4222-8222-222222222222",
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
    });

    const result = await runWriteAgent({
      userId: "11111111-1111-4111-8111-111111111111",
      trigger: "api",
      approvalRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      action: {
        actionType: "slack_write",
        toolName: "slack.post_message",
        payload: {
          channel_id: "C-DENIED",
          text: "Safe write",
        },
      },
    });

    expect(result.executed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("Civic guardrail blocked tool call");
  });
});
