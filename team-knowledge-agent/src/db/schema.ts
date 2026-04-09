import type { PoolClient } from "pg";
import { query } from "./postgres.js";

const baseSchemaStatements: string[] = [
  `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  `,
  `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, conversation_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS source_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT,
    checksum TEXT,
    last_modified_at TIMESTAMPTZ,
    permissions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_type, source_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    chunk_text TEXT NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, chunk_index)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS approval_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status TEXT NOT NULL,
    action_type TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    trace_id TEXT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS stale_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES source_documents(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence NUMERIC(5, 4),
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_sessions_user_conversation
  ON sessions (user_id, conversation_id);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_source_documents_type_source_id
  ON source_documents (source_type, source_id);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests (status);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_audit_events_trace_id
  ON audit_events (trace_id);
  `,
];

export async function initBaseSchema(): Promise<void> {
  for (const statement of baseSchemaStatements) {
    await query(statement);
  }
}

export async function initBaseSchemaWithClient(client: PoolClient): Promise<void> {
  for (const statement of baseSchemaStatements) {
    await client.query(statement);
  }
}
