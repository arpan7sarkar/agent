import { describe, expect, it } from "vitest";
import { evaluateCivicToolCall } from "../../src/civic/guardrails.js";
import { buildCivicToolRegistry } from "../../src/civic/tool-registry.js";

describe("Civic Guardrails Unauthorized Usage", () => {
  it("denies unregistered tools", () => {
    const registry = buildCivicToolRegistry({
      slackWriteChannelId: "C-ALLOWED",
      notionWritePageIds: ["page-allowed"],
    });

    const decision = evaluateCivicToolCall({
      registry,
      toolName: "slack.delete_channel",
      payload: {},
      activeProfileId: "profile-1",
      lockedProfileId: "profile-1",
      profileLockEnabled: true,
      approved: true,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("not registered");
  });

  it("denies approved Slack write attempts outside allowed channel scope", () => {
    const registry = buildCivicToolRegistry({
      slackWriteChannelId: "C-ALLOWED",
    });

    const decision = evaluateCivicToolCall({
      registry,
      toolName: "slack.post_message",
      payload: {
        channel_id: "C-DENIED",
        text: "Sensitive write",
      },
      activeProfileId: "profile-1",
      lockedProfileId: "profile-1",
      profileLockEnabled: true,
      approved: true,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("outside allowed Civic scope");
  });
});
