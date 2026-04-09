import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, civicCallToolMock, generateTextMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  civicCallToolMock: vi.fn(),
  generateTextMock: vi.fn(),
}));

vi.mock("../../src/db/postgres.js", () => ({
  query: queryMock,
}));

vi.mock("../../src/civic/client.js", () => ({
  getCivicClient: () => ({
    callTool: civicCallToolMock,
  }),
}));

vi.mock("../../src/openai/client.js", () => ({
  generateText: generateTextMock,
}));

import { runStalenessAgent } from "../../src/agents/staleness-agent.js";

describe("Staleness Agent False Positive/Negative Coverage", () => {
  let docs: Array<{
    id: string;
    source_type: string;
    source_id: string;
    url: string;
    last_modified_at: string;
    updated_at: string;
  }> = [];
  let relatedActivityAtIso: string | null = null;
  let reportCounter = 0;

  beforeEach(() => {
    docs = [];
    relatedActivityAtIso = null;
    reportCounter = 0;

    queryMock.mockReset();
    civicCallToolMock.mockReset();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({ text: "Draft" });

    queryMock.mockImplementation(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").toLowerCase();

      if (normalized.includes("from source_documents")) {
        return {
          rows: docs,
          rowCount: docs.length,
        };
      }

      if (normalized.includes("insert into stale_reports")) {
        reportCounter += 1;
        return {
          rows: [{ id: `report-${reportCounter}` }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query in staleness test: ${normalized}`);
    });

    civicCallToolMock.mockImplementation(async () => ({
      toolName: "mock",
      profileId: "profile-1",
      mode: "read" as const,
      output: relatedActivityAtIso ? { latest_activity_at: relatedActivityAtIso } : {},
    }));
  });

  it("avoids false positives by classifying recently updated docs as fresh", async () => {
    const now = Date.now();
    const docUpdatedAt = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    relatedActivityAtIso = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

    docs = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        source_type: "github",
        source_id: "repo/docs/fresh",
        url: "https://example.com/fresh",
        last_modified_at: docUpdatedAt,
        updated_at: docUpdatedAt,
      },
    ];

    const result = await runStalenessAgent({
      userId: "11111111-1111-4111-8111-111111111111",
      trigger: "cli",
      limit: 10,
    });

    expect(result.total).toBe(1);
    expect(result.results[0]?.status).toBe("fresh");
  });

  it("avoids false negatives by classifying very old docs with new activity as stale", async () => {
    const now = Date.now();
    const oldDocAt = new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString();
    relatedActivityAtIso = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

    docs = [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        source_type: "github",
        source_id: "repo/docs/old",
        url: "https://example.com/old",
        last_modified_at: oldDocAt,
        updated_at: oldDocAt,
      },
    ];

    const result = await runStalenessAgent({
      userId: "11111111-1111-4111-8111-111111111111",
      trigger: "cli",
      limit: 10,
    });

    expect(result.total).toBe(1);
    expect(result.results[0]?.status).toBe("stale");
  });
});
