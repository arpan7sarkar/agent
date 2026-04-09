import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedTextsMock, queryChunkVectorsMock, dbQueryMock } = vi.hoisted(() => ({
  embedTextsMock: vi.fn(),
  queryChunkVectorsMock: vi.fn(),
  dbQueryMock: vi.fn(),
}));

vi.mock("../../src/retrieval/embed.js", () => ({
  embedTexts: embedTextsMock,
  embedPreparedChunks: vi.fn(),
}));

vi.mock("../../src/retrieval/pinecone.js", () => ({
  buildChunkVectorRecord: vi.fn(),
  queryChunkVectors: queryChunkVectorsMock,
  upsertChunkVectors: vi.fn(),
}));

vi.mock("../../src/db/postgres.js", () => ({
  query: dbQueryMock,
}));

import { queryKnowledge } from "../../src/retrieval/query.js";

describe("Retrieval Pinecone Failures", () => {
  beforeEach(() => {
    embedTextsMock.mockReset();
    queryChunkVectorsMock.mockReset();
    dbQueryMock.mockReset();
  });

  it("surfaces Pinecone query failures during retrieval", async () => {
    embedTextsMock.mockResolvedValue([[0.11, 0.22, 0.33]]);
    queryChunkVectorsMock.mockRejectedValue(new Error("Pinecone retrieval failed"));

    await expect(queryKnowledge("Where is the onboarding checklist?")).rejects.toThrow(
      "Pinecone retrieval failed",
    );
  });
});
