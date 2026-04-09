import crypto from "node:crypto";
import { withBindings } from "../config/logger.js";
import { getCivicClient } from "../civic/client.js";
import { query } from "../db/postgres.js";
import { prepareDocumentForIndexing, type ChunkingOptions, type RetrievalSourceType } from "./chunk.js";
import { embedPreparedChunks, embedTexts } from "./embed.js";
import { buildChunkVectorRecord, queryChunkVectors, upsertChunkVectors } from "./pinecone.js";

export type IndexSourceRequest = {
  userId: string;
  sourceType: RetrievalSourceType;
  sourceId: string;
  sourceUrl?: string;
  title?: string;
  lastModifiedAt?: string;
  permissions?: Record<string, unknown>;
  // Optional local text fallback while Civic MCP transport is being wired.
  contentFallback?: string;
  civicPayload?: Record<string, unknown>;
  chunking?: ChunkingOptions;
  namespace?: string;
  correlationId?: string;
};

export type IndexedChunkRecord = {
  chunkId: string;
  documentChunkId: string;
  vectorId: string;
  chunkIndex: number;
};

export type IndexSourceResult = {
  documentId: string;
  sourceType: RetrievalSourceType;
  sourceId: string;
  chunkCount: number;
  vectorCount: number;
  checksum: string;
  indexedAt: string;
  eventualConsistencyNote: string;
  chunks: IndexedChunkRecord[];
};

export type RetrievalMatch = {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type RetrievalQueryOptions = {
  topK?: number;
  namespace?: string;
  // Set this to the current time when you query immediately after indexing.
  freshlyIndexedAt?: string;
  // Fetch live source content when index freshness is uncertain.
  preferLiveSourceRead?: boolean;
  liveReadSource?: {
    sourceType: RetrievalSourceType;
    sourceId: string;
    payload?: Record<string, unknown>;
    fallbackContent?: string;
  };
  correlationId?: string;
  userId?: string;
};

export type RetrievalQueryResult = {
  matches: RetrievalMatch[];
  eventualConsistencyWarning?: string;
  liveRead?: {
    sourceType: RetrievalSourceType;
    sourceId: string;
    content: string;
  };
};

export type LiveSourceReadRequest = {
  userId: string;
  sourceType: RetrievalSourceType;
  sourceId: string;
  payload?: Record<string, unknown>;
  fallbackContent?: string;
  correlationId?: string;
};

export type LiveSourceReadResult = {
  sourceType: RetrievalSourceType;
  sourceId: string;
  content: string;
};

type SourceDocumentRow = {
  id: string;
};

type DocumentChunkRow = {
  id: string;
};

const EVENTUAL_CONSISTENCY_WINDOW_MS = 120_000;

function mapSourceTypeToReadTool(sourceType: RetrievalSourceType): string {
  switch (sourceType) {
    case "github":
      return "github.get_file";
    case "google_drive":
      return "drive.get_file_content";
    case "slack":
      return "slack.get_channel_history";
    case "notion":
      return "notion.get_page";
    default:
      throw new Error(`Unsupported source type: ${sourceType}`);
  }
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

async function fetchContentViaCivic(input: {
  userId: string;
  sourceType: RetrievalSourceType;
  sourceId: string;
  payload?: Record<string, unknown>;
  fallbackContent?: string;
  correlationId: string;
}): Promise<string> {
  const civic = getCivicClient();
  const toolName = mapSourceTypeToReadTool(input.sourceType);

  const result = await civic.callTool({
    userId: input.userId,
    correlationId: input.correlationId,
    toolName,
    payload: {
      source_id: input.sourceId,
      ...(input.payload ?? {}),
    },
  });

  const fromTool = readStringField(result.output, [
    "content",
    "text",
    "body",
    "markdown",
    "raw",
  ]);
  if (fromTool) return fromTool;

  if (input.fallbackContent && input.fallbackContent.trim().length > 0) {
    return input.fallbackContent.trim();
  }

  throw new Error(
    `Civic tool ${toolName} returned no textual content. Provide contentFallback until remote MCP payload mapping is configured.`,
  );
}

export async function fetchLiveSourceDocument(
  request: LiveSourceReadRequest,
): Promise<LiveSourceReadResult> {
  const correlationId = request.correlationId ?? crypto.randomUUID();
  const content = await fetchContentViaCivic({
    userId: request.userId,
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    ...(request.payload ? { payload: request.payload } : {}),
    ...(request.fallbackContent ? { fallbackContent: request.fallbackContent } : {}),
    correlationId,
  });

  return {
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    content,
  };
}

function toIsoString(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

async function upsertSourceDocument(input: {
  sourceType: RetrievalSourceType;
  sourceId: string;
  sourceUrl?: string;
  checksum: string;
  lastModifiedAt?: string;
  permissions: Record<string, unknown>;
}): Promise<string> {
  const result = await query<SourceDocumentRow>(
    `
      INSERT INTO source_documents (
        source_type,
        source_id,
        url,
        checksum,
        last_modified_at,
        permissions_json,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::timestamptz,
        $6::jsonb,
        NOW()
      )
      ON CONFLICT (source_type, source_id)
      DO UPDATE SET
        url = EXCLUDED.url,
        checksum = EXCLUDED.checksum,
        last_modified_at = EXCLUDED.last_modified_at,
        permissions_json = EXCLUDED.permissions_json,
        updated_at = NOW()
      RETURNING id
    `,
    [
      input.sourceType,
      input.sourceId,
      input.sourceUrl ?? null,
      input.checksum,
      input.lastModifiedAt ?? null,
      JSON.stringify(input.permissions),
    ],
  );

  const row = result.rows[0];
  if (!row) throw new Error("Failed to upsert source_documents row.");
  return row.id;
}

async function replaceDocumentChunks(input: {
  documentId: string;
  chunks: Array<{
    chunkIndex: number;
    chunkText: string;
    metadata: Record<string, unknown>;
  }>;
}): Promise<IndexedChunkRecord[]> {
  // Remove chunks that no longer exist after re-chunking.
  await query(
    `
      DELETE FROM document_chunks
      WHERE document_id = $1::uuid
        AND chunk_index >= $2
    `,
    [input.documentId, input.chunks.length],
  );

  const persisted: IndexedChunkRecord[] = [];

  for (const chunk of input.chunks) {
    const result = await query<DocumentChunkRow>(
      `
        INSERT INTO document_chunks (document_id, chunk_index, chunk_text, metadata_json)
        VALUES ($1::uuid, $2, $3, $4::jsonb)
        ON CONFLICT (document_id, chunk_index)
        DO UPDATE SET
          chunk_text = EXCLUDED.chunk_text,
          metadata_json = EXCLUDED.metadata_json
        RETURNING id
      `,
      [input.documentId, chunk.chunkIndex, chunk.chunkText, JSON.stringify(chunk.metadata)],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to upsert document chunk row.");
    }

    persisted.push({
      chunkId: String(chunk.metadata.chunk_id),
      documentChunkId: row.id,
      vectorId: String(chunk.metadata.pinecone_vector_id),
      chunkIndex: chunk.chunkIndex,
    });
  }

  return persisted;
}

export async function indexSourceDocument(request: IndexSourceRequest): Promise<IndexSourceResult> {
  const correlationId = request.correlationId ?? crypto.randomUUID();
  const log = withBindings({ correlationId, requestId: crypto.randomUUID() });

  log.info(
    { sourceType: request.sourceType, sourceId: request.sourceId, userId: request.userId },
    "Indexing started",
  );

  const rawContent = await fetchContentViaCivic({
    userId: request.userId,
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    ...(request.civicPayload ? { payload: request.civicPayload } : {}),
    ...(request.contentFallback ? { fallbackContent: request.contentFallback } : {}),
    correlationId,
  });

  const prepared = prepareDocumentForIndexing(
    {
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(request.lastModifiedAt ? { lastModifiedAt: request.lastModifiedAt } : {}),
      permissions: request.permissions ?? {},
      content: rawContent,
    },
    request.chunking,
  );

  if (prepared.chunks.length === 0) {
    throw new Error("No chunks produced from source content; cannot index empty content.");
  }

  const embeddedChunks = await embedPreparedChunks(prepared.chunks);
  const normalizedLastModifiedAt = toIsoString(request.lastModifiedAt);

  const documentId = await upsertSourceDocument({
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    checksum: prepared.checksum,
    ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}),
    ...(normalizedLastModifiedAt ? { lastModifiedAt: normalizedLastModifiedAt } : {}),
    permissions: request.permissions ?? {},
  });

  const vectorRecords = embeddedChunks.map((chunk) =>
    buildChunkVectorRecord(chunk, documentId),
  );
  await upsertChunkVectors(vectorRecords, request.namespace);

  const persistedChunks = await replaceDocumentChunks({
    documentId,
    chunks: embeddedChunks.map((chunk) => {
      const vector = vectorRecords[chunk.chunkIndex];
      if (!vector) {
        throw new Error(`Missing Pinecone vector record for chunk index ${chunk.chunkIndex}`);
      }
      return {
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.text,
        metadata: {
          chunk_id: chunk.chunkId,
          parent_document_id: documentId,
          source_type: chunk.metadata.sourceType,
          source_url: chunk.metadata.sourceUrl ?? null,
          checksum: chunk.metadata.checksum,
          last_modified_at: chunk.metadata.lastModifiedAt ?? null,
          permissions_metadata: chunk.metadata.permissions,
          pinecone_vector_id: vector.vectorId,
        },
      };
    }),
  });

  const indexedAt = new Date().toISOString();
  log.info(
    {
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      documentId,
      chunkCount: persistedChunks.length,
    },
    "Indexing completed",
  );

  return {
    documentId,
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    chunkCount: persistedChunks.length,
    vectorCount: vectorRecords.length,
    checksum: prepared.checksum,
    indexedAt,
    eventualConsistencyNote:
      "Pinecone search is eventually consistent. Freshly indexed records may take time to appear in queries.",
    chunks: persistedChunks,
  };
}

function maybeConsistencyWarning(freshlyIndexedAt?: string): string | undefined {
  if (!freshlyIndexedAt) return undefined;
  const indexedAt = new Date(freshlyIndexedAt);
  if (Number.isNaN(indexedAt.getTime())) return undefined;
  const ageMs = Date.now() - indexedAt.getTime();
  if (ageMs <= EVENTUAL_CONSISTENCY_WINDOW_MS) {
    return "Results may be incomplete because indexing is still settling in Pinecone.";
  }
  return undefined;
}

export async function queryKnowledge(
  userQuestion: string,
  options: RetrievalQueryOptions = {},
): Promise<RetrievalQueryResult> {
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const topK = options.topK ?? 6;
  const queryEmbedding = await embedTexts([userQuestion]);
  const vector = queryEmbedding[0];
  if (!vector) {
    throw new Error("Embedding generation failed for query text.");
  }

  const pineconeResults = await queryChunkVectors({
    queryVector: vector,
    topK,
    ...(options.namespace ? { namespace: options.namespace } : {}),
  });

  const matches: RetrievalMatch[] = (pineconeResults.matches ?? []).map((match) => ({
    id: match.id,
    ...(typeof match.score === "number" ? { score: match.score } : {}),
    ...(match.metadata ? { metadata: match.metadata as Record<string, unknown> } : {}),
  }));

  const eventualConsistencyWarning = maybeConsistencyWarning(options.freshlyIndexedAt);

  const shouldLiveRead =
    options.preferLiveSourceRead === true ||
    (matches.length === 0 && Boolean(options.liveReadSource));

  if (!shouldLiveRead || !options.liveReadSource || !options.userId) {
    return {
      matches,
      ...(eventualConsistencyWarning ? { eventualConsistencyWarning } : {}),
    };
  }

  const liveReadResult = await fetchLiveSourceDocument({
    userId: options.userId,
    sourceType: options.liveReadSource.sourceType,
    sourceId: options.liveReadSource.sourceId,
    ...(options.liveReadSource.payload ? { payload: options.liveReadSource.payload } : {}),
    ...(options.liveReadSource.fallbackContent
      ? { fallbackContent: options.liveReadSource.fallbackContent }
      : {}),
    correlationId,
  });

  return {
    matches,
    ...(eventualConsistencyWarning ? { eventualConsistencyWarning } : {}),
    liveRead: {
      sourceType: liveReadResult.sourceType,
      sourceId: liveReadResult.sourceId,
      content: liveReadResult.content,
    },
  };
}
