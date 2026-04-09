import { generateText } from "../openai/client.js";

export const ROUTER_ROUTES = [
  "qa",
  "indexer",
  "staleness",
  "approval",
  "write",
] as const;

export type RouterRoute = (typeof ROUTER_ROUTES)[number];

export type RouterDecision = {
  route: RouterRoute;
  reason: string;
  modelRequestId?: string;
};

const routerInstructions = `
You are the Router Agent for a Team Knowledge system.
Your job is ONLY:
1) classify the user's request into one route
2) prepare a short reason for handoff
3) do not solve the task itself

Valid routes:
- qa: answer knowledge or how-to questions
- indexer: index, reindex, sync, ingest content
- staleness: detect stale docs or freshness issues
- approval: request/review approval decisions
- write: execute an already-approved external write

Routing policy:
- Stay narrow and route only; never perform specialist work.
- Do not improvise missing capabilities.
- Prefer delegation over explanation.
- Route to "write" only when the request clearly references an already-approved action.
- If a write is requested without clear approval evidence, route to "approval".

Output JSON only in this exact shape:
{"route":"qa|indexer|staleness|approval|write","reason":"short reason"}
`;

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function normalizeRoute(value: string): RouterRoute | null {
  const lower = value.trim().toLowerCase();
  if (ROUTER_ROUTES.includes(lower as RouterRoute)) {
    return lower as RouterRoute;
  }
  return null;
}

function parseDecision(text: string): RouterDecision | null {
  try {
    const raw = extractJsonObject(text) ?? text;
    const parsed = JSON.parse(raw) as { route?: string; reason?: string };
    const route = parsed.route ? normalizeRoute(parsed.route) : null;
    if (!route) return null;
    return {
      route,
      reason: (parsed.reason ?? "Routed by policy").trim() || "Routed by policy",
    };
  } catch {
    return null;
  }
}

function hasApprovedWriteSignal(message: string): boolean {
  const input = message.toLowerCase();
  const hasApprovalKeyword =
    /\b(already approved|approval id|approved request|request id|approval_request_id)\b/.test(
      input,
    );
  const hasDecisionKeyword = /\b(approved|execute approved|run approved)\b/.test(input);
  const hasRequestId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
    message,
  );
  return (hasApprovalKeyword || hasDecisionKeyword) && hasRequestId;
}

function applyRoutePolicy(message: string, decision: RouterDecision): RouterDecision {
  if (decision.route !== "write") {
    return decision;
  }

  if (hasApprovedWriteSignal(message)) {
    return decision;
  }

  return {
    route: "approval",
    reason:
      "Write-like request detected without clear approved request evidence; routed to approval gate.",
  };
}

function keywordFallback(message: string): RouterDecision {
  const input = message.toLowerCase();

  if (/\b(reindex|index|ingest|sync)\b/.test(input)) {
    return { route: "indexer", reason: "User asked to ingest or reindex content." };
  }
  if (/\b(stale|freshness|outdated|old doc|obsolete)\b/.test(input)) {
    return { route: "staleness", reason: "User asked for freshness or stale-doc analysis." };
  }
  if (/\b(approve|approval|reject|decision)\b/.test(input)) {
    return { route: "approval", reason: "User asked for approval flow handling." };
  }
  if (/\b(execute|apply|update|write|publish)\b/.test(input)) {
    if (hasApprovedWriteSignal(message)) {
      return { route: "write", reason: "User requested execution of an already-approved write." };
    }
    return {
      route: "approval",
      reason: "Write-like request without clear approval evidence; routed to approval first.",
    };
  }

  return { route: "qa", reason: "Default route for general knowledge Q&A." };
}

export async function classifyRequest(userMessage: string): Promise<RouterDecision> {
  const result = await generateText(routerInstructions, userMessage);
  const parsed = parseDecision(result.text);
  if (parsed) {
    const policyAdjusted = applyRoutePolicy(userMessage, parsed);
    if (result.requestId) {
      return { ...policyAdjusted, modelRequestId: result.requestId };
    }
    return policyAdjusted;
  }
  return keywordFallback(userMessage);
}

export async function summarizeHandoff(
  route: RouterRoute,
  specialistOutput: string,
): Promise<string> {
  const summaryInstructions = `
You are the Router Agent summarizing specialist output.
Return one concise paragraph for the user.
Do not invent facts beyond the specialist output.
`;

  const input = `Route: ${route}\nSpecialist output:\n${specialistOutput}`;
  const result = await generateText(summaryInstructions, input);
  const summary = result.text.trim();
  if (summary.length > 0) return summary;

  return `Route ${route} completed. ${specialistOutput}`;
}
