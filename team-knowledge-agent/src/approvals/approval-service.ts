import { getEnv } from "../config/env.js";
import {
  createApprovalRequest,
  getApprovalRequestById,
  listApprovalRequests,
  resolveApprovalRequest,
  type ApprovalRequestRecord,
} from "./approval-store.js";

export type ApprovalDecision = "approved" | "rejected";

export type ProposedAction = {
  actionType: string;
  toolName?: string;
  payload: Record<string, unknown>;
  description?: string;
};

export type ApprovalPayloadSet = {
  api: {
    approvalRequestId: string;
    status: string;
    actionType: string;
    reasons: string[];
  };
  cli: string;
  slack: string;
};

export type RiskAssessment = {
  requiresApproval: boolean;
  reasons: string[];
  riskLevel: "low" | "medium" | "high";
};

export type ApprovalProposalResult = {
  requiresApproval: boolean;
  assessment: RiskAssessment;
  approvalRequest?: ApprovalRequestRecord;
  payloads?: ApprovalPayloadSet;
};

function getString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isDocumentUpdate(action: ProposedAction): boolean {
  const actionKey = action.actionType.toLowerCase();
  const toolName = (action.toolName ?? "").toLowerCase();
  if (toolName === "notion.update_page") return true;

  return (
    actionKey.includes("document_update") ||
    actionKey.includes("doc_update") ||
    actionKey.includes("rewrite_doc") ||
    actionKey.includes("update_page")
  );
}

function isExternalWriteAction(action: ProposedAction): boolean {
  const actionKey = action.actionType.toLowerCase();
  const toolName = (action.toolName ?? "").toLowerCase();
  const writeHints = ["write", "update", "create", "delete", "publish", "post", "apply"];

  if (toolName.length > 0 && !toolName.includes("get_") && !toolName.includes("search_")) {
    return writeHints.some((hint) => toolName.includes(hint));
  }

  return writeHints.some((hint) => actionKey.includes(hint));
}

function isSlackWriteOutsideAllowedPath(action: ProposedAction): boolean {
  const toolName = (action.toolName ?? "").toLowerCase();
  const actionKey = action.actionType.toLowerCase();
  const isSlackWrite =
    toolName === "slack.post_message" ||
    actionKey.includes("slack_write") ||
    actionKey.includes("slack_post");

  if (!isSlackWrite) return false;

  const env = getEnv();
  const allowedChannel = env.CIVIC_SLACK_WRITE_CHANNEL;
  if (!allowedChannel) {
    return true;
  }

  const payloadChannel = getString(action.payload, "channel_id") ?? getString(action.payload, "channel");
  return payloadChannel !== allowedChannel;
}

function buildRiskAssessment(action: ProposedAction): RiskAssessment {
  const reasons: string[] = [];

  if (isDocumentUpdate(action)) {
    reasons.push("Document update operations require human approval.");
  }

  if (isSlackWriteOutsideAllowedPath(action)) {
    reasons.push("Slack write targets a channel outside the approved path.");
  }

  if (isExternalWriteAction(action)) {
    reasons.push("External write action may change system state and must be reviewed.");
  }

  const requiresApproval = reasons.length > 0;
  if (!requiresApproval) {
    return {
      requiresApproval: false,
      reasons: ["Action appears read-only and low risk."],
      riskLevel: "low",
    };
  }

  const riskLevel =
    reasons.length >= 2 || reasons.some((reason) => reason.includes("outside the approved path"))
      ? "high"
      : "medium";

  return {
    requiresApproval: true,
    reasons,
    riskLevel,
  };
}

function toApprovalPayloads(
  approval: ApprovalRequestRecord,
  assessment: RiskAssessment,
): ApprovalPayloadSet {
  return {
    api: {
      approvalRequestId: approval.id,
      status: approval.status,
      actionType: approval.actionType,
      reasons: assessment.reasons,
    },
    cli: `agent approve --id ${approval.id} --decision approve   # or: --decision reject`,
    slack: [
      "Approval needed:",
      `id=${approval.id}`,
      `action=${approval.actionType}`,
      ...assessment.reasons.map((reason) => `- ${reason}`),
      `Approve: /agent approve ${approval.id} approve`,
      `Reject: /agent approve ${approval.id} reject`,
    ].join("\n"),
  };
}

export async function inspectProposedAction(action: ProposedAction): Promise<RiskAssessment> {
  return buildRiskAssessment(action);
}

export async function proposeActionForApproval(input: {
  userId: string;
  action: ProposedAction;
}): Promise<ApprovalProposalResult> {
  const assessment = await inspectProposedAction(input.action);

  if (!assessment.requiresApproval) {
    return {
      requiresApproval: false,
      assessment,
    };
  }

  const approval = await createApprovalRequest({
    actionType: input.action.actionType,
    payload: {
      tool_name: input.action.toolName ?? null,
      description: input.action.description ?? null,
      payload: input.action.payload,
      risk_reasons: assessment.reasons,
      risk_level: assessment.riskLevel,
    },
    requestedBy: input.userId,
  });

  return {
    requiresApproval: true,
    assessment,
    approvalRequest: approval,
    payloads: toApprovalPayloads(approval, assessment),
  };
}

export async function respondToApprovalRequest(input: {
  approvalRequestId: string;
  decision: ApprovalDecision;
  approverId: string;
}): Promise<ApprovalRequestRecord> {
  return resolveApprovalRequest({
    approvalRequestId: input.approvalRequestId,
    status: input.decision,
    approverId: input.approverId,
  });
}

export async function getApprovalRequest(
  approvalRequestId: string,
): Promise<ApprovalRequestRecord | null> {
  return getApprovalRequestById(approvalRequestId);
}

export async function listPendingApprovals(limit = 20): Promise<ApprovalRequestRecord[]> {
  return listApprovalRequests({
    status: "pending",
    limit,
  });
}

