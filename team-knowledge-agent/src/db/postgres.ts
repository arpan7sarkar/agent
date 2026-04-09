import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getEnv } from "../config/env.js";
import { logger } from "../config/logger.js";

const env = getEnv();

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error: Error) => {
  logger.error({ err: error }, "Unexpected Postgres pool error");
});

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function getDbClient(): Promise<PoolClient> {
  return pool.connect();
}

export async function closePostgres(): Promise<void> {
  await pool.end();
}
