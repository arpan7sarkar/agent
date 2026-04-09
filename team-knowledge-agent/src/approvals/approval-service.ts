import { classifyActionRisk } from "../policy/risk-classifier.js";
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

function buildRiskAssessment(action: ProposedAction): RiskAssessment {
  const classified = classifyActionRisk(action);
  return {
    requiresApproval: classified.requiresApproval,
    reasons: classified.reasons,
    riskLevel: classified.riskLevel,
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
