import crypto from "node:crypto";
import {
  parseApprovalMessageToRequest,
  runApprovalFromSlack,
  type ApprovalAgentResult,
} from "../agents/approval-agent.js";
import { classifyRequest } from "../agents/router-agent.js";
import { newCorrelationId, withBindings } from "../config/logger.js";
import { runAgent } from "../openai/runner.js";

export type SlackTransport = {
  postMessage: (input: {
    channelId: string;
    text: string;
    threadTs?: string;
    correlationId: string;
  }) => Promise<{ ts?: string }>;
};

export type SlackMessageEvent = {
  type: "message";
  workspaceId: string;
  channelId: string;
  slackUserId: string;
  text: string;
  ts: string;
  threadTs?: string;
  correlationId?: string;
};

export type SlackApprovalDecisionEvent = {
  type: "approval_decision";
  workspaceId: string;
  channelId: string;
  slackUserId: string;
  approvalRequestId: string;
  decision: "approve" | "approved" | "reject" | "rejected";
  ts?: string;
  threadTs?: string;
  correlationId?: string;
};

export type SlackIncomingEvent = SlackMessageEvent | SlackApprovalDecisionEvent;

export type SlackRuntimeIdentity = {
  userId: string;
  conversationId: string;
};

export type SlackHandledResult = {
  kind: "ignored" | "agent_response" | "approval_prompt" | "approval_decision";
  correlationId: string;
  userId: string;
  conversationId: string;
  responseText?: string;
  traceId?: string;
};

type SlackApprovalCommand = {
  operation: "list" | "respond";
  approvalRequestId?: string;
  decision?: "approved" | "rejected";
};

export type SlackHandlerOptions = {
  transport: SlackTransport;
  botSlackUserId?: string;
};

function deterministicUuid(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));

  // Set UUID v4 and RFC4122 variant bits while keeping deterministic bytes.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function mapSlackIdentityToRuntime(input: {
  workspaceId: string;
  channelId: string;
  slackUserId: string;
  threadTs?: string;
  messageTs?: string;
}): SlackRuntimeIdentity {
  const userId = deterministicUuid(
    `slack:user:${input.workspaceId}:${input.slackUserId}`,
  );

  const conversationAnchor = input.threadTs ?? input.messageTs ?? input.channelId;
  const conversationId = deterministicUuid(
    `slack:conversation:${input.workspaceId}:${input.channelId}:${conversationAnchor}`,
  );

  return { userId, conversationId };
}

function normalizeDecision(value: string): "approved" | "rejected" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approved";
  if (normalized === "reject" || normalized === "rejected") return "rejected";
  return null;
}

function parseApprovalCommand(text: string): SlackApprovalCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const listMatch = /^\/?agent\s+approve\s+list(?:\s+(\d+))?$/i.exec(trimmed);
  if (listMatch) {
    return { operation: "list" };
  }

  const respondMatch =
    /^\/?agent\s+approve\s+([0-9a-f-]{36})\s+(approve|approved|reject|rejected)$/i.exec(
      trimmed,
    );
  if (!respondMatch) return null;

  const decisionToken = respondMatch[2];
  const approvalRequestId = respondMatch[1];
  if (!decisionToken || !approvalRequestId) return null;

  const decision = normalizeDecision(decisionToken);
  if (!decision) return null;

  return {
    operation: "respond",
    approvalRequestId,
    decision,
  };
}

function toThreadTs(event: SlackIncomingEvent): string | undefined {
  if (event.type === "message") {
    return event.threadTs ?? event.ts;
  }
  return event.threadTs ?? event.ts;
}

function toApprovalSlackText(result: ApprovalAgentResult): string {
  const sections: string[] = [result.summary];

  if (result.operation === "propose" && result.requiresApproval && result.payloads?.slack) {
    sections.push(result.payloads.slack);
  }

  if (result.operation === "list" && result.pendingApprovals && result.pendingApprovals.length > 0) {
    const preview = result.pendingApprovals
      .slice(0, 10)
      .map(
        (item) =>
          `- ${item.id} | ${item.actionType} | requested_by=${item.requestedBy} | status=${item.status}`,
      )
      .join("\n");
    sections.push(preview);
  }

  return sections.join("\n\n");
}

export class SlackHandler {
  private readonly transport: SlackTransport;
  private readonly botSlackUserId: string | undefined;

  constructor(options: SlackHandlerOptions) {
    this.transport = options.transport;
    this.botSlackUserId = options.botSlackUserId;
  }

  async handleEvent(event: SlackIncomingEvent): Promise<SlackHandledResult> {
    const correlationId = event.correlationId?.trim() || newCorrelationId();
    const log = withBindings({ correlationId, requestId: newCorrelationId() });
    const threadTs = toThreadTs(event);
    const messageTs = event.type === "message" ? event.ts : event.ts;
    const identity = mapSlackIdentityToRuntime({
      workspaceId: event.workspaceId,
      channelId: event.channelId,
      slackUserId: event.slackUserId,
      ...(threadTs ? { threadTs } : {}),
      ...(messageTs ? { messageTs } : {}),
    });

    if (this.botSlackUserId && event.slackUserId === this.botSlackUserId) {
      return {
        kind: "ignored",
        correlationId,
        userId: identity.userId,
        conversationId: identity.conversationId,
      };
    }

    if (event.type === "approval_decision") {
      return this.handleApprovalDecision(event, identity, correlationId, threadTs, log);
    }

    const parsedApprovalCommand = parseApprovalCommand(event.text);
    if (parsedApprovalCommand) {
      return this.handleApprovalCommand(
        event,
        identity,
        correlationId,
        threadTs,
        parsedApprovalCommand,
        log,
      );
    }

    const route = await classifyRequest(event.text);
    log.info(
      { slackRoute: route.route, reason: route.reason, modelRequestId: route.modelRequestId },
      "Slack message classified",
    );

    if (route.route === "approval") {
      const parsed = parseApprovalMessageToRequest(identity.userId, event.text);
      const approvalResult = await runApprovalFromSlack({
        userId: identity.userId,
        operation: parsed.operation,
        ...(parsed.action ? { action: parsed.action } : {}),
        ...(parsed.approvalRequestId ? { approvalRequestId: parsed.approvalRequestId } : {}),
        ...(parsed.decision ? { decision: parsed.decision } : {}),
        ...(typeof parsed.limit === "number" ? { limit: parsed.limit } : {}),
        correlationId,
      });

      const responseText = toApprovalSlackText(approvalResult);
      await this.transport.postMessage({
        channelId: event.channelId,
        text: responseText,
        ...(threadTs ? { threadTs } : {}),
        correlationId,
      });

      return {
        kind: "approval_prompt",
        correlationId,
        userId: identity.userId,
        conversationId: identity.conversationId,
        responseText,
      };
    }

    const runtimeResult = await runAgent({
      userId: identity.userId,
      conversationId: identity.conversationId,
      message: event.text,
      correlationId,
      requestId: newCorrelationId(),
    });

    await this.transport.postMessage({
      channelId: event.channelId,
      text: runtimeResult.response,
      ...(threadTs ? { threadTs } : {}),
      correlationId,
    });

    return {
      kind: "agent_response",
      correlationId,
      userId: identity.userId,
      conversationId: identity.conversationId,
      responseText: runtimeResult.response,
      traceId: runtimeResult.traceId,
    };
  }

  private async handleApprovalCommand(
    event: SlackMessageEvent,
    identity: SlackRuntimeIdentity,
    correlationId: string,
    threadTs: string | undefined,
    command: SlackApprovalCommand,
    log: ReturnType<typeof withBindings>,
  ): Promise<SlackHandledResult> {
    let approvalResult: ApprovalAgentResult;
    if (command.operation === "list") {
      approvalResult = await runApprovalFromSlack({
        userId: identity.userId,
        operation: "list",
        correlationId,
      });
    } else {
      if (!command.approvalRequestId || !command.decision) {
        throw new Error("Approval command is missing request ID or decision.");
      }
      approvalResult = await runApprovalFromSlack({
        userId: identity.userId,
        operation: "respond",
        approvalRequestId: command.approvalRequestId,
        decision: command.decision,
        correlationId,
      });
    }

    const responseText = toApprovalSlackText(approvalResult);
    await this.transport.postMessage({
      channelId: event.channelId,
      text: responseText,
      ...(threadTs ? { threadTs } : {}),
      correlationId,
    });

    log.info({ operation: command.operation }, "Slack approval command handled");
    return {
      kind: "approval_decision",
      correlationId,
      userId: identity.userId,
      conversationId: identity.conversationId,
      responseText,
    };
  }

  private async handleApprovalDecision(
    event: SlackApprovalDecisionEvent,
    identity: SlackRuntimeIdentity,
    correlationId: string,
    threadTs: string | undefined,
    log: ReturnType<typeof withBindings>,
  ): Promise<SlackHandledResult> {
    const decision = normalizeDecision(event.decision);
    if (!decision) {
      throw new Error(`Unsupported Slack approval decision '${event.decision}'.`);
    }

    const approvalResult = await runApprovalFromSlack({
      userId: identity.userId,
      operation: "respond",
      approvalRequestId: event.approvalRequestId,
      decision,
      correlationId,
    });

    const responseText = toApprovalSlackText(approvalResult);
    await this.transport.postMessage({
      channelId: event.channelId,
      text: responseText,
      ...(threadTs ? { threadTs } : {}),
      correlationId,
    });

    log.info(
      {
        approvalRequestId: event.approvalRequestId,
        decision,
      },
      "Slack approval decision handled",
    );

    return {
      kind: "approval_decision",
      correlationId,
      userId: identity.userId,
      conversationId: identity.conversationId,
      responseText,
    };
  }
}
