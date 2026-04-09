import { Pinecone } from "@pinecone-database/pinecone";
import { getEnv } from "../config/env.js";
import type { EmbeddedChunk } from "./embed.js";

export type PineconeChunkMetadata = {
  chunk_id: string;
  parent_document_id: string;
  source_type: string;
  source_id: string;
  source_url: string;
  checksum: string;
  last_modified_at: string;
  permissions_json: string;
  pinecone_vector_id: string;
};

export type PineconeUpsertRecord = {
  vectorId: string;
  values: number[];
  metadata: PineconeChunkMetadata;
};

export type PineconeQueryInput = {
  queryVector: number[];
  topK: number;
  namespace?: string;
  filter?: Record<string, unknown>;
};

let cachedPineconeClient: Pinecone | null = null;

export function getPineconeClient(): Pinecone {
  if (cachedPineconeClient) return cachedPineconeClient;
  const env = getEnv();
  cachedPineconeClient = new Pinecone({
    apiKey: env.PINECONE_API_KEY,
  });
  return cachedPineconeClient;
}

function getPineconeIndex(namespace?: string) {
  const env = getEnv();
  const baseIndex = getPineconeClient().index<PineconeChunkMetadata>({
    name: env.PINECONE_INDEX,
  });

  if (namespace && namespace.trim().length > 0) {
    return baseIndex.namespace(namespace.trim());
  }

  if (env.PINECONE_NAMESPACE && env.PINECONE_NAMESPACE.trim().length > 0) {
    return baseIndex.namespace(env.PINECONE_NAMESPACE.trim());
  }

  return baseIndex;
}

export function buildChunkVectorRecord(
  chunk: EmbeddedChunk,
  parentDocumentId: string,
): PineconeUpsertRecord {
  const vectorId = chunk.chunkId;
  return {
    vectorId,
    values: chunk.embedding,
    metadata: {
      chunk_id: chunk.chunkId,
      parent_document_id: parentDocumentId,
      source_type: chunk.metadata.sourceType,
      source_id: chunk.metadata.sourceId,
      source_url: chunk.metadata.sourceUrl ?? "",
      checksum: chunk.metadata.checksum,
      last_modified_at: chunk.metadata.lastModifiedAt ?? "",
      permissions_json: JSON.stringify(chunk.metadata.permissions),
      pinecone_vector_id: vectorId,
    },
  };
}

export async function upsertChunkVectors(
  records: PineconeUpsertRecord[],
  namespace?: string,
): Promise<void> {
  if (records.length === 0) return;
  const index = getPineconeIndex(namespace);
  await index.upsert({
    records: records.map((record) => ({
      id: record.vectorId,
      values: record.values,
      metadata: record.metadata,
    })),
  });
}

export async function queryChunkVectors(input: PineconeQueryInput) {
  const index = getPineconeIndex(input.namespace);
  return index.query({
    vector: input.queryVector,
    topK: input.topK,
    includeMetadata: true,
    ...(input.filter ? { filter: input.filter } : {}),
  });
}

