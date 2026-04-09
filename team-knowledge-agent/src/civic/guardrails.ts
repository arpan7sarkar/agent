import { getRegisteredTool, type CivicToolRegistry } from "./tool-registry.js";

export type CivicGuardrailInput = {
  registry: CivicToolRegistry;
  toolName: string;
  payload: Record<string, unknown>;
  activeProfileId: string;
  lockedProfileId: string;
  profileLockEnabled: boolean;
  approved: boolean;
};

export type CivicGuardrailDecision = {
  allow: boolean;
  reason: string;
  toolMode?: "read" | "write";
};

function getString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isSlackChannelAllowed(payload: Record<string, unknown>, channelId?: string): boolean {
  if (!channelId) return false;
  const payloadChannel = getString(payload, "channel_id") ?? getString(payload, "channel");
  return payloadChannel === channelId;
}

function isNotionPageAllowed(payload: Record<string, unknown>, pageIds?: string[]): boolean {
  if (!pageIds || pageIds.length === 0) return false;
  const pageId = getString(payload, "page_id");
  if (!pageId) return false;
  return pageIds.includes(pageId);
}

export function evaluateCivicToolCall(input: CivicGuardrailInput): CivicGuardrailDecision {
  const tool = getRegisteredTool(input.registry, input.toolName);
  if (!tool) {
    return {
      allow: false,
      reason: "Tool is not registered in least-privilege Civic scope.",
    };
  }

  if (input.profileLockEnabled && input.activeProfileId !== input.lockedProfileId) {
    return {
      allow: false,
      reason: "Profile lock violation: active profile does not match locked profile.",
      toolMode: tool.mode,
    };
  }

  if (tool.mode === "read") {
    return {
      allow: true,
      reason: "Read tool allowed by least-privilege registry.",
      toolMode: "read",
    };
  }

  // Deny-by-default write policy: only allow explicit scoped write tools with approval.
  if (!tool.requiresApproval || !input.approved) {
    return {
      allow: false,
      reason: "Write denied by default: approval required for this tool call.",
      toolMode: "write",
    };
  }

  if (tool.name === "slack.post_message") {
    if (!isSlackChannelAllowed(input.payload, tool.allowedSlackChannelId)) {
      return {
        allow: false,
        reason: "Slack write denied: channel is outside allowed Civic scope.",
        toolMode: "write",
      };
    }
  }

  if (tool.name === "notion.update_page") {
    if (!isNotionPageAllowed(input.payload, tool.allowedNotionPageIds)) {
      return {
        allow: false,
        reason: "Notion write denied: page is outside allowed Civic write path.",
        toolMode: "write",
      };
    }
  }

  return {
    allow: true,
    reason: "Write tool allowed by guardrails with explicit approval.",
    toolMode: "write",
  };
}

