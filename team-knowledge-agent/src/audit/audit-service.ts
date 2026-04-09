import crypto from "node:crypto";
import { withBindings } from "../config/logger.js";
import { query } from "../db/postgres.js";

type AuditDetails = Record<string, unknown>;

export type AuditRecordInput = {
  eventType: string;
  traceId?: string | undefined;
  userId?: string | undefined;
  details?: AuditDetails | undefined;
};

type AuditCommonInput = {
  traceId?: string | undefined;
  userId?: string | undefined;
  details?: AuditDetails | undefined;
};

export async function recordAuditEvent(input: AuditRecordInput): Promise<string> {
  const traceId = input.traceId ?? crypto.randomUUID();
  const log = withBindings({ correlationId: traceId, requestId: crypto.randomUUID() });

  try {
    await query(
      `
        INSERT INTO audit_events (event_type, trace_id, user_id, details_json)
        VALUES ($1, $2, NULLIF($3, '')::uuid, $4::jsonb)
      `,
      [
        input.eventType,
        traceId,
        input.userId ?? "",
        JSON.stringify(input.details ?? {}),
      ],
    );
  } catch (error) {
    // Best-effort audit write: keep primary workflow alive but make failures visible.
    log.error(
      {
        err: error,
        eventType: input.eventType,
        userId: input.userId ?? null,
      },
      "Failed to persist audit event",
    );
  }

  return traceId;
}

export async function trackAgentRun(input: AuditCommonInput & {
  phase: "started" | "completed" | "failed";
  conversationId?: string | undefined;
  sessionId?: string | undefined;
  route?: string | undefined;
  error?: string | undefined;
}): Promise<string> {
  return recordAuditEvent({
    eventType: `agent_run_${input.phase}`,
    traceId: input.traceId,
    userId: input.userId,
    details: {
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.route ? { route: input.route } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.details ? input.details : {}),
    },
  });
}

export async function trackHandoff(input: AuditCommonInput & {
  phase: "dispatched" | "completed";
  route: string;
  handoffReason?: string | undefined;
  sourceReferenceCount?: number | undefined;
}): Promise<string> {
  return recordAuditEvent({
    eventType: `handoff_${input.phase}`,
    traceId: input.traceId,
    userId: input.userId,
    details: {
      route: input.route,
      ...(input.handoffReason ? { handoffReason: input.handoffReason } : {}),
      ...(typeof input.sourceReferenceCount === "number"
        ? { sourceReferenceCount: input.sourceReferenceCount }
        : {}),
      ...(input.details ? input.details : {}),
    },
  });
}

export async function trackToolCall(input: AuditCommonInput & {
  status: "requested" | "allowed" | "blocked";
  toolName: string;
  mode?: "read" | "write" | undefined;
  profileId?: string | undefined;
  approved?: boolean | undefined;
  reason?: string | undefined;
}): Promise<string> {
  return recordAuditEvent({
    eventType: `tool_call_${input.status}`,
    traceId: input.traceId,
    userId: input.userId,
    details: {
      toolName: input.toolName,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(typeof input.approved === "boolean" ? { approved: input.approved } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.details ? input.details : {}),
    },
  });
}

export async function trackApprovalRequest(input: AuditCommonInput & {
  approvalRequestId: string;
  actionType: string;
  status: string;
  riskLevel?: string | undefined;
}): Promise<string> {
  return recordAuditEvent({
    eventType: "approval_request_created",
    traceId: input.traceId,
    userId: input.userId,
    details: {
      approvalRequestId: input.approvalRequestId,
      actionType: input.actionType,
      status: input.status,
      ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
      ...(input.details ? input.details : {}),
    },
  });
}

export async function trackApprovalDecision(input: AuditCommonInput & {
  approvalRequestId: string;
  decision: "approved" | "rejected" | "expired";
  status: string;
  approverId?: string | undefined;
}): Promise<string> {
  return recordAuditEvent({
    eventType: "approval_decision_recorded",
    traceId: input.traceId,
    userId: input.userId,
    details: {
      approvalRequestId: input.approvalRequestId,
      decision: input.decision,
      status: input.status,
      ...(input.approverId ? { approverId: input.approverId } : {}),
      ...(input.details ? input.details : {}),
    },
  });
}

export async function trackWriteExecution(input: AuditCommonInput & {
  status: "attempted" | "succeeded" | "blocked" | "failed";
  approvalRequestId?: string | undefined;
  actionType?: string | undefined;
  toolName?: string | undefined;
}): Promise<string> {
  return recordAuditEvent({
    eventType: `write_execution_${input.status}`,
    traceId: input.traceId,
    userId: input.userId,
    details: {
      ...(input.approvalRequestId ? { approvalRequestId: input.approvalRequestId } : {}),
      ...(input.actionType ? { actionType: input.actionType } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.details ? input.details : {}),
    },
  });
}

export async function trackError(input: AuditCommonInput & {
  scope: string;
  message: string;
}): Promise<string> {
  return recordAuditEvent({
    eventType: "error",
    traceId: input.traceId,
    userId: input.userId,
    details: {
      scope: input.scope,
      message: input.message,
      ...(input.details ? input.details : {}),
    },
  });
}
