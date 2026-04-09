import crypto from "node:crypto";
import { trackError, trackToolCall } from "../audit/audit-service.js";
import { getEnv } from "../config/env.js";
import { withBindings } from "../config/logger.js";
import { evaluateCivicToolCall } from "./guardrails.js";
import {
  buildCivicToolRegistry,
  listRegisteredTools,
  parseCsvList,
  type CivicToolRegistry,
} from "./tool-registry.js";

export type CivicClientOptions = {
  token: string;
  lockedProfileId: string;
  baseUrl: string;
  profileLockEnabled: boolean;
  registry: CivicToolRegistry;
};

export type CivicToolCall = {
  toolName: string;
  payload: Record<string, unknown>;
  approved?: boolean;
  profileId?: string;
  requestId?: string;
  correlationId?: string;
  userId?: string;
};

export type CivicToolResult = {
  toolName: string;
  profileId: string;
  output: Record<string, unknown>;
  mode: "read" | "write";
};

export type CivicRuntimeInfo = {
  baseUrl: string;
  lockedProfileId: string;
  profileLockEnabled: boolean;
  registeredToolNames: string[];
};

export class CivicClient {
  private readonly token: string;
  private readonly lockedProfileId: string;
  private readonly baseUrl: string;
  private readonly profileLockEnabled: boolean;
  private readonly registry: CivicToolRegistry;

  constructor(options: CivicClientOptions) {
    this.token = options.token;
    this.lockedProfileId = options.lockedProfileId;
    this.baseUrl = options.baseUrl;
    this.profileLockEnabled = options.profileLockEnabled;
    this.registry = options.registry;
  }

  getRuntimeInfo(): CivicRuntimeInfo {
    return {
      baseUrl: this.baseUrl,
      lockedProfileId: this.lockedProfileId,
      profileLockEnabled: this.profileLockEnabled,
      registeredToolNames: listRegisteredTools(this.registry).map((tool) => tool.name),
    };
  }

  private resolveProfileId(overrideProfileId?: string): string {
    if (!overrideProfileId) {
      return this.lockedProfileId;
    }
    if (this.profileLockEnabled && overrideProfileId !== this.lockedProfileId) {
      throw new Error("Civic profile override denied: profile lock is enabled.");
    }
    return overrideProfileId;
  }

  async callTool(call: CivicToolCall): Promise<CivicToolResult> {
    const profileId = this.resolveProfileId(call.profileId);
    const correlationId = call.correlationId ?? crypto.randomUUID();
    const requestId = call.requestId ?? crypto.randomUUID();
    const log = withBindings({ correlationId, requestId });
    const approved = call.approved === true;

    const decision = evaluateCivicToolCall({
      registry: this.registry,
      toolName: call.toolName,
      payload: call.payload,
      activeProfileId: profileId,
      lockedProfileId: this.lockedProfileId,
      profileLockEnabled: this.profileLockEnabled,
      approved,
    });

    log.info(
      {
        toolName: call.toolName,
        profileId,
        approved,
        userId: call.userId,
      },
      "Civic tool call requested",
    );
    await trackToolCall({
      status: "requested",
      traceId: correlationId,
      userId: call.userId,
      toolName: call.toolName,
      ...(decision.toolMode ? { mode: decision.toolMode } : {}),
      profileId,
      approved,
    });

    if (!decision.allow || !decision.toolMode) {
      log.warn(
        {
          toolName: call.toolName,
          profileId,
          reason: decision.reason,
          approved,
          userId: call.userId,
        },
        "Civic tool call blocked by guardrails",
      );
      await trackToolCall({
        status: "blocked",
        traceId: correlationId,
        userId: call.userId,
        toolName: call.toolName,
        profileId,
        approved,
        reason: decision.reason,
      });
      await trackError({
        traceId: correlationId,
        userId: call.userId,
        scope: "civic.client.callTool",
        message: decision.reason,
        details: {
          toolName: call.toolName,
          profileId,
          approved,
        },
      });
      throw new Error(`Civic guardrail blocked tool call: ${decision.reason}`);
    }

    // Step 6 scaffold: centralized Civic boundary is in place; remote MCP transport is added later.
    // We still log each call so traces remain auditable from day one.
    const output: Record<string, unknown> = {
      status: "allowed",
      provider: "civic",
      profileId,
      note: "Tool call passed guardrails. Remote Civic MCP invocation will be wired in next steps.",
    };

    log.info(
      {
        toolName: call.toolName,
        profileId,
        mode: decision.toolMode,
        userId: call.userId,
      },
      "Civic tool call allowed",
    );
    await trackToolCall({
      status: "allowed",
      traceId: correlationId,
      userId: call.userId,
      toolName: call.toolName,
      mode: decision.toolMode,
      profileId,
      approved,
    });

    return {
      toolName: call.toolName,
      profileId,
      output,
      mode: decision.toolMode,
    };
  }
}

let cachedClient: CivicClient | null = null;

export function getCivicClient(): CivicClient {
  if (cachedClient) return cachedClient;

  const env = getEnv();
  const notionWritePageIds = parseCsvList(env.CIVIC_NOTION_WRITE_PAGE_IDS);
  const jiraProjectKeys = parseCsvList(env.CIVIC_JIRA_PROJECT_KEYS);
  const gmailLabelIds = parseCsvList(env.CIVIC_GMAIL_LABEL_IDS);

  const registry = buildCivicToolRegistry({
    ...(env.CIVIC_SLACK_WRITE_CHANNEL
      ? { slackWriteChannelId: env.CIVIC_SLACK_WRITE_CHANNEL }
      : {}),
    ...(notionWritePageIds.length > 0 ? { notionWritePageIds } : {}),
    ...(jiraProjectKeys.length > 0 ? { jiraProjectKeys } : {}),
    ...(gmailLabelIds.length > 0 ? { gmailLabelIds } : {}),
  });

  cachedClient = new CivicClient({
    token: env.CIVIC_TOKEN,
    lockedProfileId: env.CIVIC_PROFILE_ID,
    baseUrl: env.CIVIC_BASE_URL,
    profileLockEnabled: env.CIVIC_LOCK_PROFILE,
    registry,
  });

  return cachedClient;
}
