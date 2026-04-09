import { query } from "../db/postgres.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRequestRecord = {
  id: string;
  status: ApprovalStatus;
  actionType: string;
  payload: Record<string, unknown>;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

type ApprovalRow = {
  id: string;
  status: ApprovalStatus;
  action_type: string;
  payload_json: Record<string, unknown>;
  requested_by: string | null;
  approved_by: string | null;
  created_at: string;
  resolved_at: string | null;
};

function mapRow(row: ApprovalRow): ApprovalRequestRecord {
  return {
    id: row.id,
    status: row.status,
    actionType: row.action_type,
    payload: row.payload_json ?? {},
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function createApprovalRequest(input: {
  actionType: string;
  payload: Record<string, unknown>;
  requestedBy: string;
}): Promise<ApprovalRequestRecord> {
  const result = await query<ApprovalRow>(
    `
      INSERT INTO approval_requests (
        status,
        action_type,
        payload_json,
        requested_by,
        created_at
      )
      VALUES (
        'pending',
        $1,
        $2::jsonb,
        $3::uuid,
        NOW()
      )
      RETURNING
        id,
        status,
        action_type,
        payload_json,
        requested_by,
        approved_by,
        created_at,
        resolved_at
    `,
    [input.actionType, JSON.stringify(input.payload), input.requestedBy],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to create approval request.");
  }
  return mapRow(row);
}

export async function getApprovalRequestById(
  approvalRequestId: string,
): Promise<ApprovalRequestRecord | null> {
  const result = await query<ApprovalRow>(
    `
      SELECT
        id,
        status,
        action_type,
        payload_json,
        requested_by,
        approved_by,
        created_at,
        resolved_at
      FROM approval_requests
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [approvalRequestId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function listApprovalRequests(input?: {
  status?: ApprovalStatus;
  limit?: number;
}): Promise<ApprovalRequestRecord[]> {
  const limit = input?.limit ?? 20;

  if (input?.status) {
    const result = await query<ApprovalRow>(
      `
        SELECT
          id,
          status,
          action_type,
          payload_json,
          requested_by,
          approved_by,
          created_at,
          resolved_at
        FROM approval_requests
        WHERE status = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [input.status, limit],
    );
    return result.rows.map(mapRow);
  }

  const result = await query<ApprovalRow>(
    `
      SELECT
        id,
        status,
        action_type,
        payload_json,
        requested_by,
        approved_by,
        created_at,
        resolved_at
      FROM approval_requests
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows.map(mapRow);
}

export async function resolveApprovalRequest(input: {
  approvalRequestId: string;
  status: "approved" | "rejected" | "expired";
  approverId: string;
}): Promise<ApprovalRequestRecord> {
  const result = await query<ApprovalRow>(
    `
      UPDATE approval_requests
      SET
        status = $2,
        approved_by = $3::uuid,
        resolved_at = NOW()
      WHERE id = $1::uuid
        AND status = 'pending'
      RETURNING
        id,
        status,
        action_type,
        payload_json,
        requested_by,
        approved_by,
        created_at,
        resolved_at
    `,
    [input.approvalRequestId, input.status, input.approverId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Approval request could not be resolved (missing or non-pending).");
  }
  return mapRow(row);
}

