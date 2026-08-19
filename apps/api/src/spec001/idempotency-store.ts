import { Spec001Error } from '@dhamani/domain';
import type { Sql } from './database.js';

/**
 * §22.4 — transactional idempotency claim.
 *
 * The claim is an uncommitted row inside the claiming transaction, so it exists only until that
 * transaction ends. `INSERT ... ON CONFLICT DO NOTHING` is what makes the documented contention
 * outcomes fall out naturally:
 *
 *   A. no competitor      -> the insert succeeds and this request executes normally;
 *   B. competitor commits -> the insert blocks on the index entry, then affects zero rows; a
 *                            fresh read returns the stored outcome, or IDEMPOTENCY_CONFLICT when
 *                            the fingerprint differs;
 *   C. competitor rolls back -> the insert blocks, then succeeds, so there is no re-claim loop to
 *                            bound and no livelock to prevent;
 *   D. the wait exceeds lock_timeout -> SQLSTATE 57014 maps to DEAL_WRITE_RETRYABLE.
 *
 * The claim carries no commandTime: §23.1 orders the claim before the Deal row lock, while §29
 * takes the single authoritative clock_timestamp() after that lock. commandTime is therefore part
 * of the settled outcome, and a deferred trigger rejects any committed claim still missing it.
 */

export type StoredOutcome = Readonly<{
  outcomeKind: 'SUCCESS' | 'TYPED_ERROR';
  outcome: Record<string, unknown>;
  commandTime: Date | null;
}>;

export type ClaimResult =
  | Readonly<{ status: 'CLAIMED'; recordId: string }>
  | Readonly<{ status: 'REPLAY'; stored: StoredOutcome }>;

export type ClaimRequest = Readonly<{
  recordId: string;
  scope: string;
  commandType: string;
  idempotencyKey: string;
  fingerprint: Uint8Array;
}>;

export async function claimIdempotency(sql: Sql, request: ClaimRequest): Promise<ClaimResult> {
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO "ApplicationIdempotencyRecord"
       ("id","scope","commandType","idempotencyKey","requestFingerprint","outcomeKind","outcome","commandTime")
     VALUES ($1,$2,$3,$4,$5,'PENDING','{}'::jsonb,NULL)
     ON CONFLICT ("scope","commandType","idempotencyKey") DO NOTHING
     RETURNING "id"`,
    [
      request.recordId,
      request.scope,
      request.commandType,
      request.idempotencyKey,
      Buffer.from(request.fingerprint),
    ],
  );
  if (inserted.rows.length === 1) return { status: 'CLAIMED', recordId: request.recordId };

  const existing = await sql.query<{
    requestFingerprint: Buffer;
    outcomeKind: string;
    outcome: Record<string, unknown>;
    commandTime: Date | null;
  }>(
    `SELECT "requestFingerprint","outcomeKind","outcome","commandTime"
       FROM "ApplicationIdempotencyRecord"
      WHERE "scope"=$1 AND "commandType"=$2 AND "idempotencyKey"=$3`,
    [request.scope, request.commandType, request.idempotencyKey],
  );
  const row = existing.rows[0];
  // Neither inserted nor resolvable to a visible committed row: report unresolved in-flight
  // state rather than guessing (§22.4 case E).
  if (!row) throw new Spec001Error('IDEMPOTENT_REQUEST_IN_PROGRESS');

  // A different semantic payload under the same key is a conflict, never a silent second meaning.
  if (!Buffer.from(request.fingerprint).equals(row.requestFingerprint))
    throw new Spec001Error('IDEMPOTENCY_CONFLICT');

  if (row.outcomeKind !== 'SUCCESS' && row.outcomeKind !== 'TYPED_ERROR')
    throw new Spec001Error('IDEMPOTENT_REQUEST_IN_PROGRESS');

  return {
    status: 'REPLAY',
    stored: {
      outcomeKind: row.outcomeKind,
      outcome: row.outcome,
      commandTime: row.commandTime,
    },
  };
}

/**
 * §22.5 — the stored outcome holds immutable commit-time facts only. Live-derived projections
 * such as current `agreementReady` or a later terminal state are never stored, so a replay can
 * never report state that post-dates the original commit.
 */
export async function settleIdempotency(
  sql: Sql,
  recordId: string,
  outcomeKind: 'SUCCESS' | 'TYPED_ERROR',
  commandTime: Date,
  outcome: Record<string, unknown>,
): Promise<void> {
  await sql.query(
    `UPDATE "ApplicationIdempotencyRecord"
        SET "outcomeKind"=$2, "outcome"=$3::jsonb, "commandTime"=$4
      WHERE "id"=$1`,
    [recordId, outcomeKind, JSON.stringify(outcome), commandTime],
  );
}
