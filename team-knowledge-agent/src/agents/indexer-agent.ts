import crypto from "node:crypto";
import { withBindings } from "../config/logger.js";
import { query } from "../db/postgres.js";
import { indexSourceDocument, type IndexSourceRequest } from "../retrieval/query.js";
import type { RetrievalSourceType } from "../retrieval/chunk.js";

export type IndexerTrigger = "api" | "cli" | "scheduler" | "agent";
export type IndexerMode = "single" | "incremental_refresh" | "full_reindex";

export type IndexerSyncItem = {
  sourceType: RetrievalSourceType;
  sourceId: string;
  sourceUrl?: string;
  title?: string;
  lastModifiedAt?: string;
  permissions?: Record<string, unknown>;
  civicPayload?: Record<string, unknown>;
  contentFallback?: string;
  namespace?: string;
  force?: boolean;
};

export type IndexerAgentRequest = {
  userId: string;
  trigger: IndexerTrigger;
  mode: IndexerMode;
  items?: IndexerSyncItem[];
  sourceTypes?: RetrievalSourceType[];
  namespace?: string;
  correlationId?: string;
};

export type IndexerItemResult = {
  sourceType: RetrievalSourceType;
  sourceId: string;
  status: "indexed" | "skipped" | "failed";
  reason?: string;
  documentId?: string;
  checksum?: string;
  chunkCount?: number;
  indexedAt?: string;
};

export type IndexerAgentResult = {
  trigger: IndexerTrigger;
  mode: IndexerMode;
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
  results: IndexerItemResult[];
  summary: string;
};

type ExistingSourceRow = {
  id: string;
  checksum: string | null;
  last_modified_at: string | null;
};

type FullReindexRow = {
  source_type: string;
  source_id: string;
  url: string | null;
  last_modified_at: string | null;
  permissions_json: Record<string, unknown> | null;
};

const VALID_SOURCE_TYPES: RetrievalSourceType[] = [
  "github",
  "google_drive",
  "slack",
  "notion",
];

function isRetrievalSourceType(value: string): value is RetrievalSourceType {
  return VALID_SOURCE_TYPES.includes(value as RetrievalSourceType);
}

function toIsoString(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function buildSummary(result: IndexerAgentResult): string {
  return [
    `Indexer ${result.mode} completed.`,
    `total=${result.total}`,
    `indexed=${result.indexed}`,
    `skipped=${result.skipped}`,
    `failed=${result.failed}`,
  ].join(" ");
}

async function getExistingSource(
  sourceType: RetrievalSourceType,
  sourceId: string,
): Promise<ExistingSourceRow | null> {
  const result = await query<ExistingSourceRow>(
    `
      SELECT id, checksum, last_modified_at
      FROM source_documents
      WHERE source_type = $1
        AND source_id = $2
      LIMIT 1
    `,
    [sourceType, sourceId],
  );

  return result.rows[0] ?? null;
}

function shouldSkipIncremental(
  item: IndexerSyncItem,
  existing: ExistingSourceRow | null,
): { skip: boolean; reason?: string } {
  if (item.force === true) {
    return { skip: false };
  }
  if (!existing) {
    return { skip: false };
  }
  const existingTs = toIsoString(existing.last_modified_at);
  const incomingTs = toIsoString(item.lastModifiedAt);

  if (existingTs && incomingTs && incomingTs <= existingTs) {
    return {
      skip: true,
      reason: "Incremental refresh skipped: source is not newer than stored metadata.",
    };
  }

  return { skip: false };
}

async function loadFullReindexItems(
  sourceTypes?: RetrievalSourceType[],
): Promise<IndexerSyncItem[]> {
  const result = await query<FullReindexRow>(
    `
      SELECT source_type, source_id, url, last_modified_at, permissions_json
      FROM source_documents
      ORDER BY updated_at DESC
    `,
  );

  const filterSet =
    sourceTypes && sourceTypes.length > 0 ? new Set<RetrievalSourceType>(sourceTypes) : null;

  const items: IndexerSyncItem[] = [];
  for (const row of result.rows) {
    if (!isRetrievalSourceType(row.source_type)) continue;
    if (filterSet && !filterSet.has(row.source_type)) continue;

    items.push({
      sourceType: row.source_type,
      sourceId: row.source_id,
      ...(row.url ? { sourceUrl: row.url } : {}),
      ...(row.last_modified_at ? { lastModifiedAt: row.last_modified_at } : {}),
      ...(row.permissions_json ? { permissions: row.permissions_json } : {}),
      force: true,
    });
  }

  return items;
}

async function indexOneItem(
  request: IndexerAgentRequest,
  item: IndexerSyncItem,
  correlationId: string,
): Promise<IndexerItemResult> {
  const existing = await getExistingSource(item.sourceType, item.sourceId);
  if (request.mode === "incremental_refresh") {
    const skip = shouldSkipIncremental(item, existing);
    if (skip.skip) {
      return {
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        status: "skipped",
        ...(skip.reason ? { reason: skip.reason } : {}),
      };
    }
  }

  try {
    const indexRequest: IndexSourceRequest = {
      userId: request.userId,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      ...(item.title ? { title: item.title } : {}),
      ...(item.lastModifiedAt ? { lastModifiedAt: item.lastModifiedAt } : {}),
      ...(item.permissions ? { permissions: item.permissions } : {}),
      ...(item.civicPayload ? { civicPayload: item.civicPayload } : {}),
      ...(item.contentFallback ? { contentFallback: item.contentFallback } : {}),
      ...(item.namespace ? { namespace: item.namespace } : {}),
      ...(request.namespace ? { namespace: request.namespace } : {}),
      correlationId,
    };

    const result = await indexSourceDocument(indexRequest);
    return {
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      status: "indexed",
      documentId: result.documentId,
      checksum: result.checksum,
      chunkCount: result.chunkCount,
      indexedAt: result.indexedAt,
    };
  } catch (error) {
    return {
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseSourceType(text: string): RetrievalSourceType | null {
  const lower = text.trim().toLowerCase();
  return isRetrievalSourceType(lower) ? lower : null;
}

export function parseIndexerMessageToRequest(
  userId: string,
  message: string,
): IndexerAgentRequest {
  const trimmed = message.trim();

  try {
    const parsed = JSON.parse(trimmed) as Partial<IndexerAgentRequest>;
    if (parsed && parsed.mode && ["single", "incremental_refresh", "full_reindex"].includes(parsed.mode)) {
      return {
        userId,
        trigger: "agent",
        mode: parsed.mode as IndexerMode,
        ...(parsed.items ? { items: parsed.items } : {}),
        ...(parsed.sourceTypes ? { sourceTypes: parsed.sourceTypes } : {}),
        ...(parsed.namespace ? { namespace: parsed.namespace } : {}),
      };
    }
  } catch {
    // Fall through to natural language parsing.
  }

  const lower = trimmed.toLowerCase();
  if (/\bfull\s+reindex\b/.test(lower) || /\breindex\s+all\b/.test(lower)) {
    return { userId, trigger: "agent", mode: "full_reindex" };
  }

  if (/\bincremental\b/.test(lower) || /\brefresh\b/.test(lower)) {
    return { userId, trigger: "agent", mode: "incremental_refresh" };
  }

  const match = /^index\s+([a-z_]+)\s+([^\s]+)$/i.exec(trimmed);
  if (match) {
    const sourceTypeToken = match[1];
    const sourceIdToken = match[2];
    const maybeType = sourceTypeToken ? parseSourceType(sourceTypeToken) : null;
    if (maybeType && sourceIdToken) {
      return {
        userId,
        trigger: "agent",
        mode: "single",
        items: [{ sourceType: maybeType, sourceId: sourceIdToken }],
      };
    }
  }

  return {
    userId,
    trigger: "agent",
    mode: "single",
    items: [],
  };
}

export async function runIndexerAgent(
  request: IndexerAgentRequest,
): Promise<IndexerAgentResult> {
  const correlationId = request.correlationId ?? crypto.randomUUID();
  const log = withBindings({ correlationId, requestId: crypto.randomUUID() });

  let items: IndexerSyncItem[] = [];
  if (request.mode === "full_reindex") {
    items = await loadFullReindexItems(request.sourceTypes);
  } else {
    items = request.items ?? [];
  }

  log.info(
    { trigger: request.trigger, mode: request.mode, itemCount: items.length },
    "Indexer job started",
  );

  const results: IndexerItemResult[] = [];
  for (const item of items) {
    const result = await indexOneItem(request, item, correlationId);
    results.push(result);
  }

  const indexed = results.filter((result) => result.status === "indexed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;

  const summary = buildSummary({
    trigger: request.trigger,
    mode: request.mode,
    total: results.length,
    indexed,
    skipped,
    failed,
    results,
    summary: "",
  });

  const finalResult: IndexerAgentResult = {
    trigger: request.trigger,
    mode: request.mode,
    total: results.length,
    indexed,
    skipped,
    failed,
    results,
    summary,
  };

  log.info(
    {
      trigger: finalResult.trigger,
      mode: finalResult.mode,
      total: finalResult.total,
      indexed: finalResult.indexed,
      skipped: finalResult.skipped,
      failed: finalResult.failed,
    },
    "Indexer job completed",
  );

  return finalResult;
}

export async function runIndexerFromApi(
  request: Omit<IndexerAgentRequest, "trigger">,
): Promise<IndexerAgentResult> {
  return runIndexerAgent({ ...request, trigger: "api" });
}

export async function runIndexerFromCli(
  request: Omit<IndexerAgentRequest, "trigger">,
): Promise<IndexerAgentResult> {
  return runIndexerAgent({ ...request, trigger: "cli" });
}

export async function runScheduledIndexerRefresh(
  request: Omit<IndexerAgentRequest, "trigger">,
): Promise<IndexerAgentResult> {
  return runIndexerAgent({ ...request, trigger: "scheduler" });
}
