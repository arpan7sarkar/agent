import crypto from "node:crypto";
import { trackError, trackWriteExecution } from "../audit/audit-service.js";
import { getCivicClient } from "../civic/client.js";
import { withBindings } from "../config/logger.js";
import { getApprovalRequestById, type ApprovalRequestRecord } from "../approvals/approval-store.js";
import { classifyActionRisk, detectWriteAction, type RiskActionInput } from "../policy/risk-classifier.js";

export type WriteTrigger = "api" | "cli" | "slack" | "agent";

export type WriteAction = {
  actionType: string;
  toolName?: string;
  payload: Record<string, unknown>;
};

export type WriteAgentRequest = {
  userId: string;
  trigger: WriteTrigger;
  approvalRequestId?: string;
  action?: WriteAction;
  correlationId?: string;
};

export type WriteAgentResult = {
  executed: boolean;
  status: "executed" | "blocked" | "failed";
  summary: string;
  approvalRequestId?: string;
  toolName?: string;
  output?: Record<string, unknown>;
};

const APPROVAL_TTL_HOURS = 72;

type ParsedMessage = {
  approvalRequestId?: string;
  action?: WriteAction;
};

function getString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isApprovalExpired(approval: ApprovalRequestRecord): boolean {
  const resolvedAt = approval.resolvedAt ?? approval.createdAt;
  const resolved = new Date(resolvedAt);
  if (Number.isNaN(resolved.getTime())) return true;

  const ageMs = Date.now() - resolved.getTime();
  return ageMs > APPROVAL_TTL_HOURS * 60 * 60 * 1000;
}

function isPayloadSubset(
  provided: Record<string, unknown>,
  approved: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(provided)) {
    const approvedValue = approved[key];
    if (isObject(value) && isObject(approvedValue)) {
      if (!isPayloadSubset(value, approvedValue)) return false;
      continue;
    }
    if (Array.isArray(value) && Array.isArray(approvedValue)) {
      if (JSON.stringify(value) !== JSON.stringify(approvedValue)) return false;
      continue;
    }
    if (approvedValue !== value) return false;
  }
  return true;
}

function actionFromApprovalPayload(approval: ApprovalRequestRecord): WriteAction {
  const payload = approval.payload;
  const maybePayload = payload["payload"];
  if (!isObject(maybePayload)) {
    throw new Error("Approval payload is missing a valid write payload object.");
  }

  const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : undefined;
  return {
    actionType: approval.actionType,
    ...(toolName ? { toolName } : {}),
    payload: maybePayload,
  };
}

function parseJsonMessage(message: string): ParsedMessage | null {
  try {
    const parsed = JSON.parse(message) as {
      approvalRequestId?: string;
      action?: WriteAction;
      actionType?: string;
      toolName?: string;
      payload?: Record<string, unknown>;
    };
    if (!parsed || typeof parsed !== "object") return null;

    if (parsed.action) {
      return {
        ...(parsed.approvalRequestId ? { approvalRequestId: parsed.approvalRequestId } : {}),
        action: parsed.action,
      };
    }

    if (parsed.actionType && parsed.payload) {
      return {
        ...(parsed.approvalRequestId ? { approvalRequestId: parsed.approvalRequestId } : {}),
        action: {
          actionType: parsed.actionType,
          ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
          payload: parsed.payload,
        },
      };
    }

    if (parsed.approvalRequestId) {
      return {
        approvalRequestId: parsed.approvalRequestId,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function parseTextMessage(message: string): ParsedMessage {
  const trimmed = message.trim();
  const approvalOnly = /([0-9a-f-]{36})/i.exec(trimmed);
  if (approvalOnly?.[1]) {
    return { approvalRequestId: approvalOnly[1] };
  }

  const slackMatch =
    /slack(?:\.post_message)?\s+channel[:= ]([A-Za-z0-9_-]+)/i.exec(trimmed) ??
    /channel[:= ]([A-Za-z0-9_-]+).*slack/i.exec(trimmed);
  if (slackMatch?.[1]) {
    return {
      action: {
        actionType: "slack_write",
        toolName: "slack.post_message",
        payload: { channel_id: slackMatch[1], text: trimmed },
      },
    };
  }

  const notionMatch = /notion\.update_page\s+([A-Za-z0-9-]+)/i.exec(trimmed);
  if (notionMatch?.[1]) {
    return {
      action: {
        actionType: "document_update",
        toolName: "notion.update_page",
        payload: { page_id: notionMatch[1], request_text: trimmed },
      },
    };
  }

  return {
    action: {
      actionType: "external_write_request",
      payload: { request_text: trimmed },
    },
  };
}

async function resolveActionWithApprovalCheck(input: {
  approvalRequestId?: string;
  action?: WriteAction;
}): Promise<{ action: WriteAction; approval: ApprovalRequestRecord }> {
  if (!input.approvalRequestId) {
    throw new Error("Missing approval request ID. Risky writes require prior approval.");
  }

  const approval = await getApprovalRequestById(input.approvalRequestId);
  if (!approval) {
    throw new Error("Approval request not found.");
  }
  if (approval.status === "pending") {
    throw new Error("Approval request is still pending.");
  }
  if (approval.status === "rejected") {
    throw new Error("Approval request was rejected.");
  }
  if (approval.status === "expired") {
    throw new Error("Approval request is expired.");
  }
  if (approval.status !== "approved") {
    throw new Error(`Approval status '${approval.status}' is not executable.`);
  }
  if (isApprovalExpired(approval)) {
    throw new Error("Approval request is approved but expired by TTL.");
  }

  const action = input.action ?? actionFromApprovalPayload(approval);
  if (approval.actionType !== action.actionType) {
    throw new Error("Action type does not match the approved request.");
  }

  const approvedTool = getString(approval.payload, "tool_name");
  if (approvedTool && action.toolName && approvedTool !== action.toolName) {
    throw new Error("Tool name does not match the approved request.");
  }

  const approvedPayloadRaw = approval.payload["payload"];
  if (isObject(approvedPayloadRaw)) {
    if (!isPayloadSubset(action.payload, approvedPayloadRaw)) {
      throw new Error("Write payload differs from approved payload.");
    }
  }

  return { action, approval };
}

function classifyForExecution(action: WriteAction): {
  risk: ReturnType<typeof classifyActionRisk>;
  isWrite: boolean;
} {
  const riskInput: RiskActionInput = {
    actionType: action.actionType,
    ...(action.toolName ? { toolName: action.toolName } : {}),
    payload: action.payload,
  };
  return {
    risk: classifyActionRisk(riskInput),
    isWrite: detectWriteAction(riskInput),
  };
}

export function parseWriteMessageToRequest(
  userId: string,
  message: string,
): WriteAgentRequest {
  const parsed = parseJsonMessage(message) ?? parseTextMessage(message);
  return {
    userId,
    trigger: "agent",
    ...(parsed.approvalRequestId ? { approvalRequestId: parsed.approvalRequestId } : {}),
    ...(parsed.action ? { action: parsed.action } : {}),
  };
}

export async function runWriteAgent(request: WriteAgentRequest): Promise<WriteAgentResult> {
  const traceId = request.correlationId ?? crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const log = withBindings({ correlationId: traceId, requestId });

  await trackWriteExecution({
    status: "attempted",
    traceId,
    userId: request.userId,
    details: {
      trigger: request.trigger,
      approvalRequestId: request.approvalRequestId ?? null,
      actionType: request.action?.actionType ?? null,
      toolName: request.action?.toolName ?? null,
    },
  });

  try {
    const { action, approval } = await resolveActionWithApprovalCheck({
      ...(request.approvalRequestId
        ? { approvalRequestId: request.approvalRequestId }
        : {}),
      ...(request.action ? { action: request.action } : {}),
    });

    const { risk, isWrite } = classifyForExecution(action);
    if (!isWrite || !risk.requiresApproval) {
      throw new Error(
        "Write agent refuses execution because action is not classified as approved risky write.",
      );
    }

    if (!action.toolName) {
      throw new Error("Write agent requires an explicit toolName for Civic-backed execution.");
    }

    const civic = getCivicClient();
    const civicResult = await civic.callTool({
      toolName: action.toolName,
      payload: action.payload,
      approved: true,
      userId: request.userId,
      correlationId: traceId,
      requestId,
    });

    await trackWriteExecution({
      status: "succeeded",
      traceId,
      userId: request.userId,
      approvalRequestId: approval.id,
      actionType: action.actionType,
      toolName: action.toolName,
      details: {
        mode: civicResult.mode,
        output: civicResult.output,
      },
    });

    log.info(
      {
        approvalRequestId: approval.id,
        actionType: action.actionType,
        toolName: action.toolName,
      },
      "Write execution succeeded",
    );

    return {
      executed: true,
      status: "executed",
      summary: `Write executed with approval ${approval.id}.`,
      approvalRequestId: approval.id,
      toolName: action.toolName,
      output: civicResult.output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await trackWriteExecution({
      status: "blocked",
      traceId,
      userId: request.userId,
      approvalRequestId: request.approvalRequestId,
      actionType: request.action?.actionType,
      toolName: request.action?.toolName,
      details: {
        error: message,
      },
    });
    await trackError({
      traceId,
      userId: request.userId,
      scope: "write-agent.runWriteAgent",
      message,
      details: {
        trigger: request.trigger,
        approvalRequestId: request.approvalRequestId ?? null,
      },
    });

    log.warn(
      { approvalRequestId: request.approvalRequestId, error: message },
      "Write execution blocked",
    );

    return {
      executed: false,
      status: "blocked",
      summary: `Write blocked: ${message}`,
      ...(request.approvalRequestId ? { approvalRequestId: request.approvalRequestId } : {}),
      ...(request.action?.toolName ? { toolName: request.action.toolName } : {}),
    };
  }
}

export async function runWriteFromApi(
  request: Omit<WriteAgentRequest, "trigger">,
): Promise<WriteAgentResult> {
  return runWriteAgent({ ...request, trigger: "api" });
}

export async function runWriteFromCli(
  request: Omit<WriteAgentRequest, "trigger">,
): Promise<WriteAgentResult> {
  return runWriteAgent({ ...request, trigger: "cli" });
}

export async function runWriteFromSlack(
  request: Omit<WriteAgentRequest, "trigger">,
): Promise<WriteAgentResult> {
  return runWriteAgent({ ...request, trigger: "slack" });
}
