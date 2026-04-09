import crypto from "node:crypto";
import { getCivicClient } from "../civic/client.js";
import { withBindings } from "../config/logger.js";
import { query } from "../db/postgres.js";
import { generateText } from "../openai/client.js";
import type { RetrievalSourceType } from "../retrieval/chunk.js";

export type StalenessStatus = "fresh" | "possibly_stale" | "stale";
export type StalenessTrigger = "api" | "cli" | "scheduler" | "agent";

export type StalenessScanRequest = {
  userId: string;
  trigger: StalenessTrigger;
  documentIds?: string[];
  sourceTypes?: RetrievalSourceType[];
  limit?: number;
  includeRewriteDraft?: boolean;
  correlationId?: string;
};

export type StalenessDocumentResult = {
  documentId: string;
  sourceType: RetrievalSourceType;
  sourceId: string;
  status: StalenessStatus;
  confidence: number;
  reasons: string[];
  relatedActivityAt?: string;
  rewriteDraft?: string;
  staleReportId: string;
};

export type StalenessScanResult = {
  trigger: StalenessTrigger;
  total: number;
  fresh: number;
  possiblyStale: number;
  stale: number;
  results: StalenessDocumentResult[];
  summary: string;
};

type SourceDocumentRow = {
  id: string;
  source_type: string;
  source_id: string;
  url: string | null;
  last_modified_at: string | null;
  updated_at: string;
};

type StaleReportInsertRow = {
  id: string;
};

const VALID_SOURCE_TYPES: RetrievalSourceType[] = [
  "github",
  "google_drive",
  "slack",
  "notion",
  "jira",
  "gmail",
];

const DAY_MS = 24 * 60 * 60 * 1000;

function isRetrievalSourceType(value: string): value is RetrievalSourceType {
  return VALID_SOURCE_TYPES.includes(value as RetrievalSourceType);
}

function isStalenessTrigger(value: string): value is StalenessTrigger {
  return ["api", "cli", "scheduler", "agent"].includes(value);
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function toIso(value: Date | null): string | undefined {
  if (!value) return undefined;
  return value.toISOString();
}

function formatDays(deltaMs: number): number {
  return Math.max(0, Math.round(deltaMs / DAY_MS));
}

function parseTimestampCandidate(value: unknown): Date | null {
  if (!value) return null;

  if (typeof value === "number") {
    const millis = value > 9_999_999_999 ? value : value * 1000;
    const fromNumber = new Date(millis);
    if (!Number.isNaN(fromNumber.getTime())) return fromNumber;
    return null;
  }

  if (typeof value === "string") {
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
      return parseTimestampCandidate(asNumber);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function extractLatestTimestamp(payload: unknown): Date | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const directKeys = [
    "latest_activity_at",
    "last_activity_at",
    "recent_activity_at",
    "last_modified_at",
    "updated_at",
    "timestamp",
    "ts",
  ];

  let latest: Date | null = null;

  for (const key of directKeys) {
    const parsed = parseTimestampCandidate(record[key]);
    if (parsed && (!latest || parsed > latest)) {
      latest = parsed;
    }
  }

  const listKeys = ["results", "items", "messages", "events"];
  for (const key of listKeys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;

    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Record<string, unknown>;
      for (const tsKey of ["timestamp", "ts", "updated_at", "created_at", "last_modified_at"]) {
        const parsed = parseTimestampCandidate(candidate[tsKey]);
        if (parsed && (!latest || parsed > latest)) {
          latest = parsed;
        }
      }
    }
  }

  return latest;
}

function classifyDocumentFreshness(input: {
  documentTimestamp: Date | null;
  relatedActivityAt: Date | null;
  now: Date;
}): { status: StalenessStatus; confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  const docAt = input.documentTimestamp;
  const relatedAt = input.relatedActivityAt;

  if (!docAt) {
    reasons.push("Document has no valid last-modified timestamp.");
    if (relatedAt) {
      reasons.push("Related GitHub/Slack activity exists but document freshness cannot be verified.");
      return { status: "stale", confidence: 0.82, reasons };
    }
    reasons.push("No reliable freshness signal is available.");
    return { status: "possibly_stale", confidence: 0.6, reasons };
  }

  const docAgeDays = formatDays(input.now.getTime() - docAt.getTime());
  reasons.push(`Document age is approximately ${docAgeDays} day(s).`);

  if (relatedAt) {
    const lagDays = formatDays(relatedAt.getTime() - docAt.getTime());
    if (lagDays >= 30) {
      reasons.push(
        `Related GitHub/Slack activity is ${lagDays} day(s) newer than the document timestamp.`,
      );
      return { status: "stale", confidence: 0.9, reasons };
    }
    if (lagDays >= 7) {
      reasons.push(
        `Related GitHub/Slack activity is ${lagDays} day(s) newer than the document timestamp.`,
      );
      return { status: "possibly_stale", confidence: 0.73, reasons };
    }
    reasons.push("Related activity does not significantly outpace document updates.");
  } else {
    reasons.push("No recent GitHub/Slack activity signal was detected.");
  }

  if (docAgeDays >= 180) {
    reasons.push("Document age exceeds six months.");
    return { status: "stale", confidence: 0.78, reasons };
  }
  if (docAgeDays >= 60) {
    reasons.push("Document age exceeds two months.");
    return { status: "possibly_stale", confidence: 0.62, reasons };
  }

  return { status: "fresh", confidence: 0.8, reasons };
}

async function collectRelatedActivitySignal(input: {
  userId: string;
  sourceId: string;
  correlationId: string;
}): Promise<Date | null> {
  const civic = getCivicClient();

  const [githubResult, slackResult] = await Promise.allSettled([
    civic.callTool({
      userId: input.userId,
      correlationId: input.correlationId,
      toolName: "github.search_code",
      payload: {
        query: input.sourceId,
        limit: 5,
      },
    }),
    civic.callTool({
      userId: input.userId,
      correlationId: input.correlationId,
      toolName: "slack.search_messages",
      payload: {
        query: input.sourceId,
        limit: 5,
      },
    }),
  ]);

  const candidates: Date[] = [];

  if (githubResult.status === "fulfilled") {
    const ts = extractLatestTimestamp(githubResult.value.output);
    if (ts) candidates.push(ts);
  }
  if (slackResult.status === "fulfilled") {
    const ts = extractLatestTimestamp(slackResult.value.output);
    if (ts) candidates.push(ts);
  }

  if (candidates.length === 0) return null;
  const latest = candidates.sort((a, b) => b.getTime() - a.getTime())[0];
  return latest ?? null;
}

async function maybeGenerateRewriteDraft(input: {
  includeRewriteDraft: boolean;
  status: StalenessStatus;
  sourceType: RetrievalSourceType;
  sourceId: string;
  sourceUrl?: string | null;
  reasons: string[];
}): Promise<string | undefined> {
  if (!input.includeRewriteDraft) return undefined;
  if (input.status === "fresh") return undefined;

  const instructions = `
You generate concise documentation rewrite drafts.
Keep output under 120 words.
Do not invent implementation details.
Focus on what should be updated based on staleness signals.
`;

  const prompt = [
    `Source type: ${input.sourceType}`,
    `Source id: ${input.sourceId}`,
    `Source url: ${input.sourceUrl ?? "unknown"}`,
    "Staleness reasons:",
    ...input.reasons.map((reason) => `- ${reason}`),
  ].join("\n");

  const result = await generateText(instructions, prompt);
  const draft = result.text.trim();
  return draft.length > 0 ? draft : undefined;
}

async function persistStaleReport(input: {
  documentId: string;
  status: StalenessStatus;
  reasons: string[];
  confidence: number;
  userId: string;
}): Promise<string> {
  const result = await query<StaleReportInsertRow>(
    `
      INSERT INTO stale_reports (
        document_id,
        status,
        reasons_json,
        confidence,
        generated_at,
        created_by
      )
      VALUES (
        $1::uuid,
        $2,
        $3::jsonb,
        $4,
        NOW(),
        $5::uuid
      )
      RETURNING id
    `,
    [input.documentId, input.status, JSON.stringify(input.reasons), input.confidence, input.userId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to persist stale report.");
  }
  return row.id;
}

async function loadCandidateDocuments(request: StalenessScanRequest): Promise<SourceDocumentRow[]> {
  const result = await query<SourceDocumentRow>(
    `
      SELECT id, source_type, source_id, url, last_modified_at, updated_at
      FROM source_documents
      ORDER BY COALESCE(last_modified_at, updated_at) ASC
      LIMIT $1
    `,
    [request.limit ?? 100],
  );

  const sourceTypeSet =
    request.sourceTypes && request.sourceTypes.length > 0
      ? new Set<RetrievalSourceType>(request.sourceTypes)
      : null;
  const documentIdSet =
    request.documentIds && request.documentIds.length > 0
      ? new Set<string>(request.documentIds)
      : null;

  return result.rows.filter((row) => {
    if (!isRetrievalSourceType(row.source_type)) return false;
    if (sourceTypeSet && !sourceTypeSet.has(row.source_type)) return false;
    if (documentIdSet && !documentIdSet.has(row.id)) return false;
    return true;
  });
}

function buildSummary(result: {
  total: number;
  fresh: number;
  possiblyStale: number;
  stale: number;
}): string {
  return [
    "Staleness scan completed.",
    `total=${result.total}`,
    `fresh=${result.fresh}`,
    `possibly_stale=${result.possiblyStale}`,
    `stale=${result.stale}`,
  ].join(" ");
}

export async function runStalenessAgent(
  request: StalenessScanRequest,
): Promise<StalenessScanResult> {
  const correlationId = request.correlationId ?? crypto.randomUUID();
  const log = withBindings({ correlationId, requestId: crypto.randomUUID() });
  const now = new Date();

  const candidates = await loadCandidateDocuments(request);
  log.info(
    { trigger: request.trigger, candidateCount: candidates.length },
    "Staleness scan started",
  );

  const results: StalenessDocumentResult[] = [];

  for (const document of candidates) {
    const sourceType = document.source_type as RetrievalSourceType;
    const documentTimestamp = parseDate(document.last_modified_at) ?? parseDate(document.updated_at);
    const relatedActivityAt = await collectRelatedActivitySignal({
      userId: request.userId,
      sourceId: document.source_id,
      correlationId,
    });

    const classification = classifyDocumentFreshness({
      documentTimestamp,
      relatedActivityAt,
      now,
    });

    const rewriteDraft = await maybeGenerateRewriteDraft({
      includeRewriteDraft: request.includeRewriteDraft === true,
      status: classification.status,
      sourceType,
      sourceId: document.source_id,
      sourceUrl: document.url,
      reasons: classification.reasons,
    });

    const staleReportId = await persistStaleReport({
      documentId: document.id,
      status: classification.status,
      reasons: classification.reasons,
      confidence: classification.confidence,
      userId: request.userId,
    });

    const relatedActivityIso = toIso(relatedActivityAt);
    const documentResult: StalenessDocumentResult = {
      documentId: document.id,
      sourceType,
      sourceId: document.source_id,
      status: classification.status,
      confidence: classification.confidence,
      reasons: classification.reasons,
      staleReportId,
    };
    if (relatedActivityIso) {
      documentResult.relatedActivityAt = relatedActivityIso;
    }
    if (rewriteDraft) {
      documentResult.rewriteDraft = rewriteDraft;
    }
    results.push(documentResult);
  }

  const fresh = results.filter((item) => item.status === "fresh").length;
  const possiblyStale = results.filter((item) => item.status === "possibly_stale").length;
  const stale = results.filter((item) => item.status === "stale").length;

  const finalResult: StalenessScanResult = {
    trigger: request.trigger,
    total: results.length,
    fresh,
    possiblyStale,
    stale,
    results,
    summary: buildSummary({
      total: results.length,
      fresh,
      possiblyStale,
      stale,
    }),
  };

  log.info(
    {
      trigger: request.trigger,
      total: finalResult.total,
      fresh: finalResult.fresh,
      possiblyStale: finalResult.possiblyStale,
      stale: finalResult.stale,
    },
    "Staleness scan completed",
  );

  return finalResult;
}

export function parseStalenessMessageToRequest(
  userId: string,
  message: string,
): StalenessScanRequest {
  const trimmed = message.trim();

  try {
    const parsed = JSON.parse(trimmed) as Partial<StalenessScanRequest>;
    if (
      parsed &&
      typeof parsed.trigger === "string" &&
      isStalenessTrigger(parsed.trigger) &&
      typeof parsed.userId === "string" &&
      parsed.userId.length > 0
    ) {
      return {
        userId: parsed.userId,
        trigger: parsed.trigger,
        ...(parsed.documentIds ? { documentIds: parsed.documentIds } : {}),
        ...(parsed.sourceTypes ? { sourceTypes: parsed.sourceTypes } : {}),
        ...(typeof parsed.limit === "number" ? { limit: parsed.limit } : {}),
        ...(typeof parsed.includeRewriteDraft === "boolean"
          ? { includeRewriteDraft: parsed.includeRewriteDraft }
          : {}),
        ...(parsed.correlationId ? { correlationId: parsed.correlationId } : {}),
      };
    }
    if (parsed) {
      return {
        userId,
        trigger: "agent",
        ...(parsed.documentIds ? { documentIds: parsed.documentIds } : {}),
        ...(parsed.sourceTypes ? { sourceTypes: parsed.sourceTypes } : {}),
        ...(typeof parsed.limit === "number" ? { limit: parsed.limit } : {}),
        ...(typeof parsed.includeRewriteDraft === "boolean"
          ? { includeRewriteDraft: parsed.includeRewriteDraft }
          : {}),
      };
    }
  } catch {
    // Fall through to keyword parser.
  }

  const lower = trimmed.toLowerCase();
  return {
    userId,
    trigger: "agent",
    ...(lower.includes("draft") ? { includeRewriteDraft: true } : {}),
    ...(lower.includes("all") ? { limit: 500 } : {}),
  };
}

export async function runStalenessFromApi(
  request: Omit<StalenessScanRequest, "trigger">,
): Promise<StalenessScanResult> {
  return runStalenessAgent({ ...request, trigger: "api" });
}

export async function runStalenessFromCli(
  request: Omit<StalenessScanRequest, "trigger">,
): Promise<StalenessScanResult> {
  return runStalenessAgent({ ...request, trigger: "cli" });
}

export async function runScheduledStalenessScan(
  request: Omit<StalenessScanRequest, "trigger">,
): Promise<StalenessScanResult> {
  return runStalenessAgent({ ...request, trigger: "scheduler" });
}
