import {
  getApprovalRequest,
  listPendingApprovals,
  proposeActionForApproval,
  respondToApprovalRequest,
  type ApprovalDecision,
  type ApprovalPayloadSet,
  type ProposedAction,
} from "../approvals/approval-service.js";
import type { ApprovalRequestRecord } from "../approvals/approval-store.js";

export type ApprovalTrigger = "api" | "cli" | "slack" | "agent";
export type ApprovalOperation = "propose" | "respond" | "list";

export type ApprovalAgentRequest = {
  userId: string;
  trigger: ApprovalTrigger;
  operation: ApprovalOperation;
  action?: ProposedAction;
  approvalRequestId?: string;
  decision?: ApprovalDecision;
  limit?: number;
};

export type ApprovalAgentResult = {
  operation: ApprovalOperation;
  summary: string;
  requiresApproval?: boolean;
  approvalRequest?: ApprovalRequestRecord;
  payloads?: ApprovalPayloadSet;
  pendingApprovals?: ApprovalRequestRecord[];
};

type ParsedMessage = {
  operation: ApprovalOperation;
  action?: ProposedAction;
  approvalRequestId?: string;
  decision?: ApprovalDecision;
  limit?: number;
};

function parseJsonMessage(message: string): ParsedMessage | null {
  try {
    const parsed = JSON.parse(message) as Partial<ApprovalAgentRequest>;
    if (!parsed || typeof parsed !== "object") return null;

    if (parsed.operation === "propose" && parsed.action) {
      return {
        operation: "propose",
        action: parsed.action,
      };
    }
    if (
      parsed.operation === "respond" &&
      parsed.approvalRequestId &&
      (parsed.decision === "approved" || parsed.decision === "rejected")
    ) {
      return {
        operation: "respond",
        approvalRequestId: parsed.approvalRequestId,
        decision: parsed.decision,
      };
    }
    if (parsed.operation === "list") {
      return {
        operation: "list",
        ...(typeof parsed.limit === "number" ? { limit: parsed.limit } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function parseDecisionToken(value: string): ApprovalDecision | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approved";
  if (normalized === "reject" || normalized === "rejected") return "rejected";
  return null;
}

function parseTextMessage(message: string): ParsedMessage {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith("list approval") || lower.includes("pending approvals")) {
    return { operation: "list" };
  }

  const respondMatch = /(?:approve|approval)\s+([0-9a-f-]{36})\s+(approve|approved|reject|rejected)/i.exec(
    trimmed,
  );
  if (respondMatch) {
    const approvalRequestId = respondMatch[1];
    const decisionToken = respondMatch[2];
    const decision = decisionToken ? parseDecisionToken(decisionToken) : null;
    if (decision && approvalRequestId) {
      return {
        operation: "respond",
        approvalRequestId,
        decision,
      };
    }
  }

  const notionMatch = /notion\.update_page\s+([0-9a-zA-Z-]+)/i.exec(trimmed);
  if (notionMatch) {
    return {
      operation: "propose",
      action: {
        actionType: "document_update",
        toolName: "notion.update_page",
        payload: { page_id: notionMatch[1], raw_request: trimmed },
        description: "Requested Notion page update.",
      },
    };
  }

  const slackMatch =
    /slack(?:\.post_message)?\s+channel[:= ]([A-Za-z0-9_-]+)/i.exec(trimmed) ??
    /channel[:= ]([A-Za-z0-9_-]+).*slack/i.exec(trimmed);
  if (slackMatch) {
    return {
      operation: "propose",
      action: {
        actionType: "slack_write",
        toolName: "slack.post_message",
        payload: { channel_id: slackMatch[1], raw_request: trimmed },
        description: "Requested Slack write operation.",
      },
    };
  }

  return {
    operation: "propose",
    action: {
      actionType: "external_write_request",
      payload: { raw_request: trimmed },
      description: "Proposed external action from natural language request.",
    },
  };
}

export function parseApprovalMessageToRequest(
  userId: string,
  message: string,
): ApprovalAgentRequest {
  const parsed = parseJsonMessage(message) ?? parseTextMessage(message);
  return {
    userId,
    trigger: "agent",
    operation: parsed.operation,
    ...(parsed.action ? { action: parsed.action } : {}),
    ...(parsed.approvalRequestId ? { approvalRequestId: parsed.approvalRequestId } : {}),
    ...(parsed.decision ? { decision: parsed.decision } : {}),
    ...(typeof parsed.limit === "number" ? { limit: parsed.limit } : {}),
  };
}

function formatPendingApprovalSummary(pending: ApprovalRequestRecord[]): string {
  if (pending.length === 0) {
    return "No pending approval requests.";
  }
  const items = pending.map((item) => `${item.id}:${item.actionType}`).join(", ");
  return `Pending approvals (${pending.length}): ${items}`;
}

export async function runApprovalAgent(
  request: ApprovalAgentRequest,
): Promise<ApprovalAgentResult> {
  if (request.operation === "list") {
    const pending = await listPendingApprovals(request.limit ?? 20);
    return {
      operation: "list",
      pendingApprovals: pending,
      summary: formatPendingApprovalSummary(pending),
    };
  }

  if (request.operation === "respond") {
    if (!request.approvalRequestId || !request.decision) {
      throw new Error("Approval response requires approvalRequestId and decision.");
    }

    const updated = await respondToApprovalRequest({
      approvalRequestId: request.approvalRequestId,
      decision: request.decision,
      approverId: request.userId,
    });

    const refreshed = await getApprovalRequest(updated.id);
    return {
      operation: "respond",
      approvalRequest: refreshed ?? updated,
      summary: `Approval request ${updated.id} is now ${updated.status}.`,
    };
  }

  if (!request.action) {
    throw new Error("Approval proposal requires an action payload.");
  }

  const proposal = await proposeActionForApproval({
    userId: request.userId,
    action: request.action,
  });

  if (!proposal.requiresApproval) {
    return {
      operation: "propose",
      requiresApproval: false,
      summary: "Action classified as low risk. Approval is not required.",
    };
  }

  if (!proposal.approvalRequest || !proposal.payloads) {
    throw new Error("Approval was required but request creation failed.");
  }

  return {
    operation: "propose",
    requiresApproval: true,
    approvalRequest: proposal.approvalRequest,
    payloads: proposal.payloads,
    summary: `Approval request ${proposal.approvalRequest.id} created for ${proposal.approvalRequest.actionType}.`,
  };
}

export async function runApprovalFromApi(
  request: Omit<ApprovalAgentRequest, "trigger">,
): Promise<ApprovalAgentResult> {
  return runApprovalAgent({ ...request, trigger: "api" });
}

export async function runApprovalFromCli(
  request: Omit<ApprovalAgentRequest, "trigger">,
): Promise<ApprovalAgentResult> {
  return runApprovalAgent({ ...request, trigger: "cli" });
}

export async function runApprovalFromSlack(
  request: Omit<ApprovalAgentRequest, "trigger">,
): Promise<ApprovalAgentResult> {
  return runApprovalAgent({ ...request, trigger: "slack" });
}
