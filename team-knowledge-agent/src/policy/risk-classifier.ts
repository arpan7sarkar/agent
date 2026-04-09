import { getEnv } from "../config/env.js";

export type RiskLevel = "low" | "medium" | "high";

export type RiskActionInput = {
  actionType: string;
  toolName?: string;
  payload: Record<string, unknown>;
};

export type RiskClassification = {
  isWriteAction: boolean;
  requiresApproval: boolean;
  riskLevel: RiskLevel;
  reasons: string[];
};

function getString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isDocumentUpdate(action: RiskActionInput): boolean {
  const actionKey = action.actionType.toLowerCase();
  const toolName = (action.toolName ?? "").toLowerCase();
  return (
    toolName === "notion.update_page" ||
    actionKey.includes("document_update") ||
    actionKey.includes("doc_update") ||
    actionKey.includes("rewrite_doc") ||
    actionKey.includes("update_page")
  );
}

function isSlackWriteAction(action: RiskActionInput): boolean {
  const actionKey = action.actionType.toLowerCase();
  const toolName = (action.toolName ?? "").toLowerCase();
  return (
    toolName === "slack.post_message" ||
    actionKey.includes("slack_write") ||
    actionKey.includes("slack_post")
  );
}

function isSlackWriteOutsideAllowedPath(action: RiskActionInput): boolean {
  if (!isSlackWriteAction(action)) return false;
  const env = getEnv();
  const allowedChannel = env.CIVIC_SLACK_WRITE_CHANNEL;
  if (!allowedChannel) return true;

  const payloadChannel =
    getString(action.payload, "channel_id") ?? getString(action.payload, "channel");
  return payloadChannel !== allowedChannel;
}

function isNotionWriteOutsideAllowedPath(action: RiskActionInput): boolean {
  const toolName = (action.toolName ?? "").toLowerCase();
  if (toolName !== "notion.update_page") return false;

  const env = getEnv();
  const allowedPageIds = parseCsv(env.CIVIC_NOTION_WRITE_PAGE_IDS);
  if (allowedPageIds.length === 0) return true;

  const pageId = getString(action.payload, "page_id");
  if (!pageId) return true;
  return !allowedPageIds.includes(pageId);
}

export function detectWriteAction(action: RiskActionInput): boolean {
  const actionKey = action.actionType.toLowerCase();
  const toolName = (action.toolName ?? "").toLowerCase();
  const writeHints = ["write", "update", "create", "delete", "publish", "post", "apply"];

  if (toolName.length > 0 && !toolName.includes("get_") && !toolName.includes("search_")) {
    return writeHints.some((hint) => toolName.includes(hint));
  }

  return writeHints.some((hint) => actionKey.includes(hint));
}

export function classifyActionRisk(action: RiskActionInput): RiskClassification {
  const reasons: string[] = [];
  const isWriteAction = detectWriteAction(action);

  if (isDocumentUpdate(action)) {
    reasons.push("Document updates are risky and require approval.");
  }

  if (isSlackWriteOutsideAllowedPath(action)) {
    reasons.push("Slack write is outside approved channel scope.");
  }

  if (isNotionWriteOutsideAllowedPath(action)) {
    reasons.push("Notion update is outside approved write page scope.");
  }

  if (isWriteAction) {
    reasons.push("External write action can change system state.");
  }

  const requiresApproval = reasons.length > 0;
  if (!requiresApproval) {
    return {
      isWriteAction,
      requiresApproval: false,
      riskLevel: "low",
      reasons: ["Action appears low-risk/read-only."],
    };
  }

  const highRisk =
    reasons.some((reason) => reason.includes("outside approved")) ||
    reasons.some((reason) => reason.includes("outside approved")) ||
    reasons.length >= 2;

  return {
    isWriteAction,
    requiresApproval: true,
    riskLevel: highRisk ? "high" : "medium",
    reasons,
  };
}

