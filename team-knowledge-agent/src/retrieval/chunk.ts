import crypto from "node:crypto";

export type RetrievalSourceType =
  | "github"
  | "google_drive"
  | "slack"
  | "notion"
  | "jira"
  | "gmail";

export type SourceDocumentInput = {
  sourceType: RetrievalSourceType;
  sourceId: string;
  sourceUrl?: string;
  title?: string;
  content: string;
  lastModifiedAt?: string;
  permissions?: Record<string, unknown>;
};

export type ChunkingOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
};

export type ChunkMetadata = {
  chunkId: string;
  chunkIndex: number;
  sourceType: RetrievalSourceType;
  sourceId: string;
  sourceUrl?: string;
  checksum: string;
  lastModifiedAt?: string;
  permissions: Record<string, unknown>;
  title?: string;
};

export type PreparedChunk = {
  chunkId: string;
  chunkIndex: number;
  text: string;
  metadata: ChunkMetadata;
};

export type PreparedDocument = {
  normalizedText: string;
  checksum: string;
  chunks: PreparedChunk[];
};

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clampChunkSettings(options: ChunkingOptions): { chunkSize: number; chunkOverlap: number } {
  const chunkSize =
    typeof options.chunkSize === "number" && options.chunkSize > 100
      ? Math.floor(options.chunkSize)
      : DEFAULT_CHUNK_SIZE;

  const rawOverlap =
    typeof options.chunkOverlap === "number" && options.chunkOverlap >= 0
      ? Math.floor(options.chunkOverlap)
      : DEFAULT_CHUNK_OVERLAP;

  const chunkOverlap = Math.min(rawOverlap, Math.max(0, chunkSize - 50));
  return { chunkSize, chunkOverlap };
}

export function normalizeSourceText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function splitIntoChunks(text: string, options: ChunkingOptions): string[] {
  if (!text) return [];

  const { chunkSize, chunkOverlap } = clampChunkSettings(options);
  const chunks: string[] = [];

  let cursor = 0;
  while (cursor < text.length) {
    const rawEnd = Math.min(cursor + chunkSize, text.length);
    let end = rawEnd;

    if (rawEnd < text.length) {
      const lastBreak = text.lastIndexOf("\n", rawEnd);
      if (lastBreak > cursor + Math.floor(chunkSize * 0.5)) {
        end = lastBreak;
      } else {
        const lastSpace = text.lastIndexOf(" ", rawEnd);
        if (lastSpace > cursor + Math.floor(chunkSize * 0.5)) {
          end = lastSpace;
        }
      }
    }

    const chunk = text.slice(cursor, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= text.length) {
      break;
    }
    cursor = Math.max(end - chunkOverlap, cursor + 1);
  }

  return chunks;
}

export function prepareDocumentForIndexing(
  sourceDocument: SourceDocumentInput,
  options: ChunkingOptions = {},
): PreparedDocument {
  const normalizedText = normalizeSourceText(sourceDocument.content);
  const checksum = sha256(normalizedText);
  const chunkTexts = splitIntoChunks(normalizedText, options);
  const permissions = sourceDocument.permissions ?? {};

  const chunks: PreparedChunk[] = chunkTexts.map((text, index) => {
    const chunkId = sha256(`${sourceDocument.sourceType}:${sourceDocument.sourceId}:${checksum}:${index}`);
    return {
      chunkId,
      chunkIndex: index,
      text,
      metadata: {
        chunkId,
        chunkIndex: index,
        sourceType: sourceDocument.sourceType,
        sourceId: sourceDocument.sourceId,
        ...(sourceDocument.sourceUrl ? { sourceUrl: sourceDocument.sourceUrl } : {}),
        checksum,
        ...(sourceDocument.lastModifiedAt
          ? { lastModifiedAt: sourceDocument.lastModifiedAt }
          : {}),
        permissions,
        ...(sourceDocument.title ? { title: sourceDocument.title } : {}),
      },
    };
  });

  return {
    normalizedText,
    checksum,
    chunks,
  };
}
