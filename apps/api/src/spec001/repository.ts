import {
  Spec001Error,
  type CurrentRevisionIntegrity,
  verifyRevisionIntegrity,
  type DealSnapshot,
  type DealState,
  type KernelPorts,
  type ResponseState,
  type RevisionState,
  type SlotState,
} from '@dhamani/domain';
import type { Sql } from './database.js';

/**
 * Persistence adapter for the Deal kernel.
 *
 * Every authoritative read happens *after* the Deal row lock is held (§23.1), so the snapshot a
 * command reasons about cannot change underneath it for the life of the transaction.
 */

export type LockedDealRow = Readonly<{
  id: string;
  publicReference: string;
  dealType: string;
  currentRevisionId: string;
  sentAt: Date;
  inviteExpiresAt: Date;
  firstMutualAcceptedAt: Date | null;
  terminationReason: string | null;
  terminatedAt: Date | null;
  version: number;
  createdAt: Date;
}>;

/** §23.1 step 2 — the mandatory Deal row lock. Returns undefined when the Deal does not exist. */
export async function lockDeal(sql: Sql, dealId: string): Promise<LockedDealRow | undefined> {
  const result = await sql.query<LockedDealRow>(
    `SELECT "id","publicReference","dealType"::text AS "dealType","currentRevisionId","sentAt",
            "inviteExpiresAt","firstMutualAcceptedAt",
            "terminationReason"::text AS "terminationReason","terminatedAt","version","createdAt"
       FROM "Deal" WHERE "id" = $1 FOR UPDATE`,
    [dealId],
  );
  return result.rows[0];
}

export function toDealState(row: LockedDealRow): DealState {
  return {
    id: row.id,
    dealType: row.dealType as DealState['dealType'],
    currentRevisionId: row.currentRevisionId,
    sentAt: row.sentAt,
    inviteExpiresAt: row.inviteExpiresAt,
    firstMutualAcceptedAt: row.firstMutualAcceptedAt,
    terminationReason: row.terminationReason as DealState['terminationReason'],
    terminatedAt: row.terminatedAt,
    version: row.version,
  };
}

/**
 * All Deal-scoped precondition state, read under the lock in one place (§23.1).
 *
 * The current revision's integrity is validated here from the authoritative BYTEA columns and the
 * verdict is carried on the snapshot, so §18 readiness can require a *passing* current revision
 * rather than merely an existing one. The verdict is computed, never stored or client-supplied,
 * and a failure is recorded rather than thrown so the caller can apply it at the correct §23.3
 * precedence step.
 */
export async function loadDealSnapshot(
  sql: Sql,
  row: LockedDealRow,
  ports: KernelPorts,
): Promise<DealSnapshot> {
  const [slots, revisions, responses] = await Promise.all([
    sql.query<SlotState>(
      `SELECT "slotKind"::text AS "slotKind","role"::text AS "role","principalId",
              "pendingInviteId","boundAt"
         FROM "DealPartySlot" WHERE "dealId" = $1 ORDER BY "slotKind"`,
      [row.id],
    ),
    sql.query<RevisionState>(
      `SELECT "id","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId"
         FROM "AgreementRevision" WHERE "dealId" = $1 ORDER BY "revisionNumber"`,
      [row.id],
    ),
    sql.query<ResponseState>(
      `SELECT "revisionId","principalId","responseKind"::text AS "responseKind",
              "responseOrigin"::text AS "responseOrigin"
         FROM "RevisionResponse" WHERE "dealId" = $1`,
      [row.id],
    ),
  ]);
  // Computed here rather than defaulted, so a snapshot can only claim VERIFIED after the stored
  // bytes were actually re-hashed. UNVERIFIED remains the fail-closed value for any other path.
  const currentRevisionIntegrity: CurrentRevisionIntegrity = await assertCurrentRevisionIntegrity(
    sql,
    row.id,
    row.dealType,
    row.currentRevisionId,
    ports,
  ).then(
    () => 'VERIFIED' as const,
    (error: unknown) => {
      if (error instanceof Spec001Error && error.code === 'REVISION_INTEGRITY_FAILURE')
        return 'FAILED' as const;
      throw error;
    },
  );

  return Object.freeze({
    deal: toDealState(row),
    slots: slots.rows,
    revisions: revisions.rows,
    responses: responses.rows,
    currentRevisionIntegrity,
  });
}

/**
 * §11.3 / §23.3 step 10 — current-revision integrity is verified from the authoritative BYTEA
 * columns, never reconstructed from a JSON/JSONB projection. A failure returns
 * REVISION_INTEGRITY_FAILURE and the caller commits no requested contractual mutation.
 */
export async function assertCurrentRevisionIntegrity(
  sql: Sql,
  dealId: string,
  dealType: string,
  revisionId: string,
  ports: KernelPorts,
): Promise<{ termsSchemaId: string; termsPayloadCanonicalBytes: Uint8Array }> {
  const result = await sql.query<{
    revisionNumber: number;
    predecessorRevisionId: string | null;
    termsSchemaId: string;
    termsPayloadCanonicalBytes: Buffer;
    integrityPreimageCanonicalBytes: Buffer;
    integrityFingerprint: Buffer;
  }>(
    `SELECT "revisionNumber","predecessorRevisionId","termsSchemaId","termsPayloadCanonicalBytes",
            "integrityPreimageCanonicalBytes","integrityFingerprint"
       FROM "AgreementRevision" WHERE "id" = $1 AND "dealId" = $2`,
    [revisionId, dealId],
  );
  const row = result.rows[0];
  if (!row) throw new Spec001Error('REVISION_NOT_FOUND');
  verifyRevisionIntegrity(
    {
      dealId,
      dealType: dealType as never,
      revisionNumber: row.revisionNumber,
      predecessorRevisionId: row.predecessorRevisionId,
      termsSchemaId: row.termsSchemaId,
      termsPayloadCanonicalBytes: new Uint8Array(row.termsPayloadCanonicalBytes),
      integrityPreimageCanonicalBytes: new Uint8Array(row.integrityPreimageCanonicalBytes),
      integrityFingerprint: new Uint8Array(row.integrityFingerprint),
    },
    ports.sha256,
  );
  return {
    termsSchemaId: row.termsSchemaId,
    termsPayloadCanonicalBytes: new Uint8Array(row.termsPayloadCanonicalBytes),
  };
}

export type AuditEvent = Readonly<{
  dealId: string;
  eventType: string;
  actorScope: string;
  targetRevisionId: string | null;
  commandTime: Date;
  dealVersion: number;
  correlationId: string;
  metadata: Record<string, unknown>;
}>;

/** §26 — appended in the same transaction as the domain write it describes. */
export async function appendAuditEvent(
  sql: Sql,
  ports: KernelPorts,
  event: AuditEvent,
): Promise<void> {
  await sql.query(
    `INSERT INTO "DealAgreementAuditEvent"
       ("id","dealId","eventType","actorScope","targetRevisionId","commandTime","dealVersion",
        "correlationId","metadata")
     VALUES ($1,$2,$3::"DealAuditEventType",$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      ports.newUuidV7(),
      event.dealId,
      event.eventType,
      event.actorScope,
      event.targetRevisionId,
      event.commandTime,
      event.dealVersion,
      event.correlationId,
      JSON.stringify(event.metadata),
    ],
  );
}

export async function insertResponse(
  sql: Sql,
  ports: KernelPorts,
  input: {
    dealId: string;
    revisionId: string;
    principalId: string;
    responseKind: 'ACCEPT' | 'REJECT';
    responseOrigin: 'EXPLICIT' | 'REVISION_CREATOR_AUTO';
    commandTime: Date;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO "RevisionResponse"
       ("id","dealId","revisionId","principalId","responseKind","responseOrigin","createdAt")
     VALUES ($1,$2,$3,$4,$5::"ResponseKind",$6::"ResponseOrigin",$7)`,
    [
      ports.newUuidV7(),
      input.dealId,
      input.revisionId,
      input.principalId,
      input.responseKind,
      input.responseOrigin,
      input.commandTime,
    ],
  );
}

/**
 * §23.4 — one Deal UPDATE per successful command, carrying exactly one version increment. The
 * database trigger independently rejects any other increment, so multiple subwrites cannot
 * silently inflate the version.
 */
export async function updateDeal(
  sql: Sql,
  dealId: string,
  expectedVersion: number,
  changes: {
    currentRevisionId?: string;
    firstMutualAcceptedAt?: Date;
    terminationReason?: string;
    terminatedAt?: Date;
  },
): Promise<number> {
  const assignments: string[] = ['"version" = "version" + 1'];
  const values: unknown[] = [dealId, expectedVersion];
  const add = (column: string, value: unknown): void => {
    values.push(value);
    assignments.push(`"${column}" = $${values.length}`);
  };
  if (changes.currentRevisionId !== undefined) add('currentRevisionId', changes.currentRevisionId);
  if (changes.firstMutualAcceptedAt !== undefined)
    add('firstMutualAcceptedAt', changes.firstMutualAcceptedAt);
  if (changes.terminationReason !== undefined) {
    values.push(changes.terminationReason);
    assignments.push(`"terminationReason" = $${values.length}::"TerminationReason"`);
  }
  if (changes.terminatedAt !== undefined) add('terminatedAt', changes.terminatedAt);

  const result = await sql.query<{ version: number }>(
    `UPDATE "Deal" SET ${assignments.join(', ')}
      WHERE "id" = $1 AND "version" = $2
      RETURNING "version"`,
    values,
  );
  const version = result.rows[0]?.version;
  // The row is locked for this transaction, so a version mismatch here means the caller reasoned
  // about stale state rather than that another writer intervened.
  if (version === undefined) throw new Spec001Error('DEAL_WRITE_RETRYABLE');
  return version;
}

export async function insertSuccessorRevision(
  sql: Sql,
  input: {
    id: string;
    dealId: string;
    revisionNumber: number;
    predecessorRevisionId: string;
    createdByPrincipalId: string;
    termsSchemaId: string;
    termsPayloadCanonicalBytes: Uint8Array;
    integrityPreimageCanonicalBytes: Uint8Array;
    integrityFingerprint: Uint8Array;
    commandTime: Date;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO "AgreementRevision"
       ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId",
        "termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes",
        "integrityFingerprint","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.id,
      input.dealId,
      input.revisionNumber,
      input.predecessorRevisionId,
      input.createdByPrincipalId,
      input.termsSchemaId,
      Buffer.from(input.termsPayloadCanonicalBytes),
      Buffer.from(input.integrityPreimageCanonicalBytes),
      Buffer.from(input.integrityFingerprint),
      input.commandTime,
    ],
  );
}

export async function bindCounterpartySlot(
  sql: Sql,
  input: { dealId: string; pendingInviteId: string; principalId: string; commandTime: Date },
): Promise<boolean> {
  // `execute` is used rather than `query` because the affected-row count is the answer here: a
  // statement without RETURNING yields no rows, so counting rows would always report failure.
  const affected = await sql.execute(
    `UPDATE "DealPartySlot"
        SET "principalId" = $3, "boundAt" = $4
      WHERE "dealId" = $1
        AND "slotKind" = 'COUNTERPARTY'
        AND "pendingInviteId" = $2
        AND "principalId" IS NULL`,
    [input.dealId, input.pendingInviteId, input.principalId, input.commandTime],
  );
  return affected === 1;
}
