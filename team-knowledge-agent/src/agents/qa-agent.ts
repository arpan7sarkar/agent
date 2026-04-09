import { generateText } from "../openai/client.js";
import { query } from "../db/postgres.js";
import {
  fetchLiveSourceDocument,
  queryKnowledge,
  type RetrievalMatch,
} from "../retrieval/query.js";
import type { RetrievalSourceType } from "../retrieval/chunk.js";

type ChunkContextRow = {
  vector_id: string;
  chunk_text: string;
};

export type QaSourceReference = {
  label: string;
  vectorId: string;
  score?: number;
  sourceType?: string;
  sourceId?: string;
  sourceUrl?: string;
  parentDocumentId?: string;
  chunkId?: string;
};

export type QaAgentInput = {
  userId: string;
  question: string;
  correlationId?: string;
  topK?: number;
};

export type QaAgentResult = {
  answer: string;
  grounded: boolean;
  sourceReferences: QaSourceReference[];
  retrievalWarning?: string;
};

type GeneratedQaPayload = {
  answer?: string;
  grounded?: boolean;
  used_sources?: string[];
};

const INSUFFICIENT_EVIDENCE_ANSWER =
  "I do not have enough grounded evidence in indexed knowledge to answer that confidently yet.";

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!metadata) return undefined;
  const value = metadata[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function parseGeneratedPayload(raw: string): GeneratedQaPayload | null {
  try {
    return JSON.parse(raw) as GeneratedQaPayload;
  } catch {
    return null;
  }
}

async function fetchChunkTextMap(vectorIds: string[]): Promise<Map<string, string>> {
  if (vectorIds.length === 0) return new Map();

  const result = await query<ChunkContextRow>(
    `
      SELECT
        metadata_json->>'pinecone_vector_id' AS vector_id,
        chunk_text
      FROM document_chunks
      WHERE metadata_json->>'pinecone_vector_id' = ANY($1::text[])
    `,
    [vectorIds],
  );

  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.vector_id, row.chunk_text);
  }
  return map;
}

function toSourceReferences(matches: RetrievalMatch[]): QaSourceReference[] {
  return matches.map((match, index) => {
    const metadata = match.metadata;
    const sourceType = getMetadataString(metadata, "source_type");
    const sourceId = getMetadataString(metadata, "source_id");
    const sourceUrl = getMetadataString(metadata, "source_url");
    const parentDocumentId = getMetadataString(metadata, "parent_document_id");
    const chunkId = getMetadataString(metadata, "chunk_id");

    const reference: QaSourceReference = {
      label: `S${index + 1}`,
      vectorId: match.id,
      ...(typeof match.score === "number" ? { score: match.score } : {}),
    };

    if (sourceType) reference.sourceType = sourceType;
    if (sourceId) reference.sourceId = sourceId;
    if (sourceUrl) reference.sourceUrl = sourceUrl;
    if (parentDocumentId) reference.parentDocumentId = parentDocumentId;
    if (chunkId) reference.chunkId = chunkId;

    return reference;
  });
}

function shouldFetchLiveDocs(matches: RetrievalMatch[], retrievalWarning?: string): boolean {
  if (retrievalWarning) return true;
  if (matches.length < 2) return true;

  const topScore = matches[0]?.score;
  if (typeof topScore === "number" && topScore < 0.65) return true;
  if (typeof topScore !== "number") return true;

  return false;
}

function pickLiveSourceCandidates(references: QaSourceReference[]): Array<{
  sourceType: RetrievalSourceType;
  sourceId: string;
}> {
  const chosen: Array<{ sourceType: RetrievalSourceType; sourceId: string }> = [];
  const seen = new Set<string>();

  for (const reference of references) {
    if (!reference.sourceType || !reference.sourceId) continue;
    const type = reference.sourceType as RetrievalSourceType;
    if (
      !["github", "google_drive", "slack", "notion", "jira", "gmail"].includes(
        type,
      )
    )
      continue;

    const key = `${type}:${reference.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push({ sourceType: type, sourceId: reference.sourceId });
    if (chosen.length >= 2) break;
  }

  return chosen;
}

function buildGroundedContext(
  references: QaSourceReference[],
  chunkTextByVectorId: Map<string, string>,
  liveDocs: Array<{ sourceType: RetrievalSourceType; sourceId: string; content: string }>,
): string {
  const retrievalContext = references
    .map((reference) => {
      const text = chunkTextByVectorId.get(reference.vectorId) ?? "(chunk text unavailable)";
      return [
        `[${reference.label}]`,
        `score=${reference.score ?? "n/a"}`,
        `source_type=${reference.sourceType ?? "unknown"}`,
        `source_id=${reference.sourceId ?? "unknown"}`,
        `source_url=${reference.sourceUrl ?? "unknown"}`,
        `text=${text}`,
      ].join(" | ");
    })
    .join("\n");

  const liveContext =
    liveDocs.length === 0
      ? "None"
      : liveDocs
          .map(
            (doc, index) =>
              `[L${index + 1}] source_type=${doc.sourceType} | source_id=${doc.sourceId} | content=${doc.content}`,
          )
          .join("\n");

  return `Retrieved chunks:\n${retrievalContext || "None"}\n\nLive source reads:\n${liveContext}`;
}

export async function runQaAgent(input: QaAgentInput): Promise<QaAgentResult> {
  const retrieval = await queryKnowledge(input.question, {
    topK: input.topK ?? 6,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  });

  const sourceReferences = toSourceReferences(retrieval.matches);
  const chunkTextByVectorId = await fetchChunkTextMap(sourceReferences.map((ref) => ref.vectorId));

  let liveDocs: Array<{ sourceType: RetrievalSourceType; sourceId: string; content: string }> = [];
  if (shouldFetchLiveDocs(retrieval.matches, retrieval.eventualConsistencyWarning)) {
    const candidates = pickLiveSourceCandidates(sourceReferences);
    liveDocs = await Promise.all(
      candidates.map((candidate) =>
        fetchLiveSourceDocument({
          userId: input.userId,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        }),
      ),
    );
  }

  if (sourceReferences.length === 0 && liveDocs.length === 0) {
    return {
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      grounded: false,
      sourceReferences: [],
      ...(retrieval.eventualConsistencyWarning
        ? { retrievalWarning: retrieval.eventualConsistencyWarning }
        : {}),
    };
  }

  const groundedContext = buildGroundedContext(sourceReferences, chunkTextByVectorId, liveDocs);

  const instructions = `
You are the QA Agent for team knowledge.
Rules:
1) Use only the provided grounded context.
2) If evidence is insufficient or conflicting, refuse unsupported claims.
3) Never invent facts, links, IDs, or steps.
4) Keep the answer concise and practical.
5) Cite used retrieval sources with labels like [S1], [S2], and live reads as [L1], [L2] when used.

Return JSON only:
{
  "answer": "string",
  "grounded": true|false,
  "used_sources": ["S1","S2","L1"]
}
`;

  const qaInput = `User question:\n${input.question}\n\n${groundedContext}`;
  const generation = await generateText(instructions, qaInput);
  const parsed = parseGeneratedPayload(generation.text);

  if (!parsed || !parsed.answer || parsed.answer.trim().length === 0) {
    return {
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      grounded: false,
      sourceReferences,
      ...(retrieval.eventualConsistencyWarning
        ? { retrievalWarning: retrieval.eventualConsistencyWarning }
        : {}),
    };
  }

  return {
    answer: parsed.answer.trim(),
    grounded: parsed.grounded === true,
    sourceReferences,
    ...(retrieval.eventualConsistencyWarning
      ? { retrievalWarning: retrieval.eventualConsistencyWarning }
      : {}),
  };
}
