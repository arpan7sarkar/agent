import { getEnv } from "../config/env.js";
import { getOpenAIClient } from "../openai/client.js";
import type { PreparedChunk } from "./chunk.js";

export type EmbeddedChunk = PreparedChunk & {
  embedding: number[];
};

const EMBEDDING_BATCH_SIZE = 64;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const env = getEnv();
  const client = getOpenAIClient();
  const vectors: number[][] = [];

  for (let index = 0; index < texts.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(index, index + EMBEDDING_BATCH_SIZE);
    const response = await client.embeddings.create({
      model: env.OPENAI_EMBEDDING_MODEL,
      input: batch,
    });

    const ordered = response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    vectors.push(...ordered);
  }

  return vectors;
}

export async function embedPreparedChunks(chunks: PreparedChunk[]): Promise<EmbeddedChunk[]> {
  if (chunks.length === 0) return [];

  const vectors = await embedTexts(chunks.map((chunk) => chunk.text));
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding cardinality mismatch: expected ${chunks.length}, got ${vectors.length}`,
    );
  }

  return chunks.map((chunk, index) => {
    const embedding = vectors[index];
    if (!embedding) {
      throw new Error(`Missing embedding vector at index ${index}`);
    }
    return {
      ...chunk,
      embedding,
    };
  });
}
