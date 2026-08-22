import { randomUUID } from 'node:crypto';
import { Spec001Error } from '../../../packages/domain/src/index.ts';
import { productionKernelPorts } from '../../../apps/api/src/spec001/crypto.ts';
import {
  createKernelDatabase,
  type KernelDatabase,
} from '../../../apps/api/src/spec001/database.ts';
import { createFormalDeal } from '../../../apps/api/src/spec001/commands/create-formal-deal.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';

/**
 * Shared harness for the SPEC-001 real-PostgreSQL evidence suites.
 *
 * A missing DATABASE_URL throws rather than skipping: under the SPEC-001 evidence rules a skipped
 * item counts as a failure, so the suite must never quietly degrade to a no-op.
 */
export function requireConnectionString(): string {
  const connectionString = process.env.SPEC001_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('SPEC-001 integration evidence requires DATABASE_URL or SPEC001_DATABASE_URL');
  return connectionString;
}

export function ownerPool(): KernelDatabase {
  return createKernelDatabase(requireConnectionString());
}

/**
 * Connection string for the constrained, non-owner runtime role. Direct-DB and privilege evidence
 * must run as this role: the same probe executed as owner or superuser proves nothing.
 */
export function runtimeConnectionString(): string {
  const explicit = process.env.SPEC001_RUNTIME_DATABASE_URL;
  if (explicit) return explicit;
  const url = new URL(requireConnectionString());
  url.username = 'dhamani_runtime';
  url.password = process.env.SPEC001_RUNTIME_PASSWORD ?? 'runtime_test_only';
  return url.toString();
}

export const ports = productionKernelPorts;

export function terms(title: string, extra: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ common: { title }, typeTerms: { note: 'inert business data', ...extra } }),
  );
}

export type Party = { principalId: string };

/** Row shapes the evidence suites read back from PostgreSQL. */
export type DealRow = {
  id: string;
  currentRevisionId: string;
  firstMutualAcceptedAt: Date | null;
  terminationReason: string | null;
  terminatedAt: Date | null;
  version: number;
  sentAt: Date;
  inviteExpiresAt: Date;
};
export type RevisionRow = {
  id: string;
  revisionNumber: number;
  predecessorRevisionId: string | null;
  createdByPrincipalId: string;
  termsSchemaId: string;
};
export type ResponseRow = {
  revisionId: string;
  principalId: string;
  responseKind: string;
  responseOrigin: string;
};

export type BornDeal = {
  dealId: string;
  creatorId: string;
  counterpartyId: string;
  revisionId: string;
  publicReference: string;
};

/** Births a Deal with both slots already bound to distinct Principals. */
export async function bornDeal(
  pool: KernelDatabase,
  options: { dealType?: string; creatorRole?: string; termsSchemaId?: string; title?: string } = {},
): Promise<BornDeal> {
  const creatorId = randomUUID();
  const counterpartyId = randomUUID();
  const result = await createFormalDeal(pool, ports, {
    actorPrincipalId: creatorId,
    correlationId: randomUUID(),
    dealType: options.dealType ?? 'GOODS',
    creatorRole: options.creatorRole ?? 'BUYER',
    counterpartyTarget: { kind: 'PRINCIPAL', principalId: counterpartyId },
    termsSchemaId: options.termsSchemaId ?? 'dhamani.goods.v1',
    rawTerms: terms(options.title ?? 'Bicycle purchase'),
    idempotencyKey: randomUUID(),
  });
  return {
    dealId: result.dealId,
    creatorId,
    counterpartyId,
    revisionId: result.currentRevisionId,
    publicReference: result.publicReference,
  };
}

/** Births a Deal and drives it to first mutual acceptance of R1. */
export async function mutuallyAcceptedDeal(pool: KernelDatabase): Promise<BornDeal> {
  const deal = await bornDeal(pool);
  await acceptCurrentRevision(pool, ports, {
    actorPrincipalId: deal.counterpartyId,
    correlationId: randomUUID(),
    dealId: deal.dealId,
    targetRevisionId: deal.revisionId,
    idempotencyKey: randomUUID(),
  });
  return deal;
}

export async function errorCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Spec001Error ? error.code : `UNEXPECTED:${String(error)}`;
  }
  return 'NO_ERROR_THROWN';
}

export async function errorOf(run: () => Promise<unknown>): Promise<Spec001Error | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Spec001Error) return error;
    throw error;
  }
  return undefined;
}

/**
 * Forces a Deal's invitation window into the past by rewriting only `sentAt`/`inviteExpiresAt`
 * directly as owner. This is a clock-shifting fixture, not a product path: the kernel itself can
 * never move those fields, which the immutability trigger independently proves.
 */
export async function backdateInvitation(pool: KernelDatabase, dealId: string): Promise<void> {
  const client = await pool.connect();
  try {
    // Disable, mutate and re-enable inside ONE transaction with a bounded lock_timeout. This
    // keeps the ACCESS EXCLUSIVE lock brief, leaves no window in which the guard is observably
    // off, and cannot leak a disabled trigger if the process dies mid-fixture.
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('ALTER TABLE "Deal" DISABLE TRIGGER "Deal_update_guard"');
    // Shift the whole window relatively so the exact sentAt + 168h relationship is preserved.
    // Two clock_timestamp() calls in one statement return different instants and would violate
    // the Deal_invite_window_check constraint.
    await client.query(
      `UPDATE "Deal"
          SET "sentAt" = "sentAt" - interval '169 hours',
              "inviteExpiresAt" = "inviteExpiresAt" - interval '169 hours'
        WHERE "id" = $1`,
      [dealId],
    );
    await client.query('ALTER TABLE "Deal" ENABLE ALWAYS TRIGGER "Deal_update_guard"');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Simulates hostile/corrupted stored bytes by lifting the append-only guard for exactly one
 * statement, atomically. The kernel itself can never reach this state, which is the point.
 */
export async function corruptRevisionBytes(
  pool: KernelDatabase,
  statement: string,
  values: unknown[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      'ALTER TABLE "AgreementRevision" DISABLE TRIGGER "AgreementRevision_no_update"',
    );
    await client.query(statement, values);
    await client.query(
      'ALTER TABLE "AgreementRevision" ENABLE ALWAYS TRIGGER "AgreementRevision_no_update"',
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function dealRow(pool: KernelDatabase, dealId: string): Promise<DealRow> {
  const result = await pool.query<DealRow>(
    `SELECT "id","currentRevisionId","firstMutualAcceptedAt",
            "terminationReason"::text AS "terminationReason","terminatedAt","version",
            "sentAt","inviteExpiresAt"
       FROM "Deal" WHERE "id"=$1`,
    [dealId],
  );
  return result.rows[0]!;
}

export async function auditEvents(pool: KernelDatabase, dealId: string): Promise<string[]> {
  const result = await pool.query<{ eventType: string }>(
    `SELECT "eventType"::text AS "eventType" FROM "DealAgreementAuditEvent"
      WHERE "dealId"=$1 ORDER BY "dealVersion", "eventType"`,
    [dealId],
  );
  return result.rows.map((row) => row.eventType);
}

export async function revisionRows(pool: KernelDatabase, dealId: string): Promise<RevisionRow[]> {
  const result = await pool.query<RevisionRow>(
    `SELECT "id","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId"
       FROM "AgreementRevision" WHERE "dealId"=$1 ORDER BY "revisionNumber"`,
    [dealId],
  );
  return result.rows;
}

export async function responseRows(pool: KernelDatabase, dealId: string): Promise<ResponseRow[]> {
  const result = await pool.query<ResponseRow>(
    `SELECT "revisionId","principalId","responseKind"::text AS "responseKind",
            "responseOrigin"::text AS "responseOrigin"
       FROM "RevisionResponse" WHERE "dealId"=$1`,
    [dealId],
  );
  return result.rows;
}

export { randomUUID };
