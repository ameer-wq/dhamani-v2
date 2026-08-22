import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { Spec001Error, verifyRevisionIntegrity } from '../../../packages/domain/src/index.ts';
import { productionKernelPorts, sha256, uuidV7 } from '../../../apps/api/src/spec001/crypto.ts';
import { createKernelDatabase } from '../../../apps/api/src/spec001/database.ts';
import {
  createFormalDeal,
  type CreateFormalDealResult,
} from '../../../apps/api/src/spec001/commands/create-formal-deal.ts';

/**
 * These are real-PostgreSQL integration tests. A missing DATABASE_URL fails loudly rather than
 * skipping, because a skipped item counts as a failure in the SPEC-001 evidence rules.
 */
const connectionString = process.env.SPEC001_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error('SPEC-001 integration evidence requires DATABASE_URL or SPEC001_DATABASE_URL');

const pool = createKernelDatabase(connectionString);

afterAll(async () => {
  await pool.end();
});

function termsFor(title: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ common: { title }, typeTerms: { note: 'inert business data' } }),
  );
}

function baseInput(overrides: Partial<Parameters<typeof createFormalDeal>[2]> = {}) {
  return {
    actorPrincipalId: randomUUID(),
    correlationId: randomUUID(),
    dealType: 'GOODS',
    creatorRole: 'BUYER',
    counterpartyTarget: { kind: 'PRINCIPAL' as const, principalId: randomUUID() },
    termsSchemaId: 'dhamani.goods.v1',
    rawTerms: termsFor('Bicycle purchase'),
    idempotencyKey: randomUUID(),
    ...overrides,
  } as Parameters<typeof createFormalDeal>[2];
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Spec001Error ? error.code : `UNEXPECTED:${String(error)}`;
  }
  return 'NO_ERROR_THROWN';
}

describe('SPEC-001 formal Deal birth against real PostgreSQL', () => {
  it('spec001_e01_formal_birth', async () => {
    const input = baseInput();
    const result = await createFormalDeal(pool, productionKernelPorts, input);
    expect(result.replayed).toBe(false);

    const deal = await pool.query<{
      id: string;
      publicReference: string;
      dealType: string;
      currentRevisionId: string;
      sentAt: Date;
      inviteExpiresAt: Date;
      firstMutualAcceptedAt: Date | null;
      terminationReason: string | null;
      version: number;
    }>(
      `SELECT "id","publicReference","dealType"::text AS "dealType","currentRevisionId","sentAt",
              "inviteExpiresAt","firstMutualAcceptedAt","terminationReason","version"
         FROM "Deal" WHERE "id"=$1`,
      [result.dealId],
    );
    expect(deal.rowCount).toBe(1);
    const row = deal.rows[0]!;
    expect(row.currentRevisionId).toBe(result.currentRevisionId);
    expect(row.version).toBe(1);
    expect(row.firstMutualAcceptedAt).toBeNull();
    expect(row.terminationReason).toBeNull();
    expect(row.publicReference).toMatch(
      /^DH-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    // §9 — inviteExpiresAt is exactly sentAt + 168 hours, from the single DB command time.
    expect(row.inviteExpiresAt.getTime() - row.sentAt.getTime()).toBe(168 * 3600 * 1000);

    // Exactly two slots: one bound CREATOR, one COUNTERPARTY.
    const slots = await pool.query(
      `SELECT "slotKind"::text AS "slotKind","role"::text AS role,"principalId","pendingInviteId","boundAt"
         FROM "DealPartySlot" WHERE "dealId"=$1 ORDER BY "slotKind"`,
      [result.dealId],
    );
    expect(slots.rowCount).toBe(2);
    const counterparty = slots.rows.find((slot) => slot.slotKind === 'COUNTERPARTY')!;
    const creator = slots.rows.find((slot) => slot.slotKind === 'CREATOR')!;
    expect(creator.principalId).toBe(input.actorPrincipalId);
    expect(creator.role).toBe('BUYER');
    // The complementary role is server-derived, never client-submitted.
    expect(counterparty.role).toBe('SELLER');

    // R1 with no predecessor, and a verifiable integrity fingerprint.
    const revision = await pool.query<{
      id: string;
      revisionNumber: number;
      predecessorRevisionId: string | null;
      termsSchemaId: string;
      termsPayloadCanonicalBytes: Uint8Array;
      integrityPreimageCanonicalBytes: Uint8Array;
      integrityFingerprint: Uint8Array;
    }>(
      `SELECT "id","revisionNumber","predecessorRevisionId","termsSchemaId",
              "termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint"
         FROM "AgreementRevision" WHERE "dealId"=$1`,
      [result.dealId],
    );
    expect(revision.rowCount).toBe(1);
    const r1 = revision.rows[0]!;
    expect(r1.revisionNumber).toBe(1);
    expect(r1.predecessorRevisionId).toBeNull();
    expect(() =>
      verifyRevisionIntegrity(
        {
          dealId: result.dealId,
          dealType: 'GOODS',
          revisionNumber: 1,
          predecessorRevisionId: null,
          termsSchemaId: r1.termsSchemaId,
          termsPayloadCanonicalBytes: new Uint8Array(r1.termsPayloadCanonicalBytes),
          integrityPreimageCanonicalBytes: new Uint8Array(r1.integrityPreimageCanonicalBytes),
          integrityFingerprint: new Uint8Array(r1.integrityFingerprint),
        },
        sha256,
      ),
    ).not.toThrow();

    // §14 — the creator's auto-ACCEPT is a persisted immutable row, not a UI simulation.
    const responses = await pool.query(
      `SELECT "principalId","responseKind"::text AS "responseKind",
              "responseOrigin"::text AS "responseOrigin"
         FROM "RevisionResponse" WHERE "dealId"=$1`,
      [result.dealId],
    );
    expect(responses.rowCount).toBe(1);
    expect(responses.rows[0]!.principalId).toBe(input.actorPrincipalId);
    expect(responses.rows[0]!.responseKind).toBe('ACCEPT');
    expect(responses.rows[0]!.responseOrigin).toBe('REVISION_CREATOR_AUTO');

    // Audit trail written in the same transaction, carrying the resulting Deal version.
    const audit = await pool.query<{ eventType: string; dealVersion: number; commandTime: Date }>(
      `SELECT "eventType"::text AS "eventType","dealVersion","commandTime"
         FROM "DealAgreementAuditEvent" WHERE "dealId"=$1 ORDER BY "eventType"`,
      [result.dealId],
    );
    expect(audit.rows.map((event) => event.eventType).sort()).toEqual([
      'DEAL_CREATED',
      'REVISION_ACCEPTED_AUTO',
      'REVISION_CREATED',
    ]);
    for (const event of audit.rows) {
      expect(event.dealVersion).toBe(1);
      // §29 — every timestamp this command wrote came from the same single command time.
      expect(event.commandTime.getTime()).toBe(row.sentAt.getTime());
    }

    const idempotency = await pool.query<{
      outcomeKind: string;
      outcome: Record<string, unknown>;
    }>(
      `SELECT "outcomeKind","outcome" FROM "ApplicationIdempotencyRecord"
        WHERE "scope"=$1 AND "commandType"='CreateFormalDeal' AND "idempotencyKey"=$2`,
      [`PRINCIPAL:${input.actorPrincipalId}`, input.idempotencyKey],
    );
    expect(idempotency.rowCount).toBe(1);
    expect(idempotency.rows[0]!.outcomeKind).toBe('SUCCESS');
    expect(idempotency.rows[0]!.outcome.dealId).toBe(result.dealId);
  });

  it('spec001_e02_create_retries_sequential_and_concurrent', async () => {
    // §22.4(B): for the SAME key with the SAME fingerprint the answer is the stored outcome.
    // IDEMPOTENCY_CONFLICT is reserved for a *different* fingerprint, so seeing it here would
    // mean the same semantic command had been given two meanings — it must fail this evidence.
    const SAME_FINGERPRINT_LOSER_CODES = new Set([
      'IDEMPOTENT_REQUEST_IN_PROGRESS',
      'DEAL_WRITE_RETRYABLE',
    ]);

    // ---- A. 10,000 real sequential same-key, same-payload retries ----
    const sequentialInput = baseInput();
    const first = await createFormalDeal(pool, productionKernelPorts, sequentialInput);
    expect(first.replayed).toBe(false);

    // §22.4(D)/(E) instruct the caller to retry the same semantic command and key on a retryable
    // or unresolved outcome, so the evidence follows that contract instead of treating a
    // transient as divergence. A same-fingerprint conflict remains fatal (asserted below).
    let transientRetries = 0;
    const replayOnce = async (attempt: number): Promise<CreateFormalDealResult> => {
      for (let tries = 0; tries < 5; tries += 1) {
        try {
          return await createFormalDeal(pool, productionKernelPorts, sequentialInput);
        } catch (error) {
          if (!(error instanceof Spec001Error)) throw error;
          expect(error.code, 'same-key same-fingerprint must never conflict').not.toBe(
            'IDEMPOTENCY_CONFLICT',
          );
          if (!SAME_FINGERPRINT_LOSER_CODES.has(error.code))
            throw new Error(`sequential retry ${attempt} unexpected code ${error.code}`, {
              cause: error,
            });
          transientRetries += 1;
        }
      }
      throw new Error(`sequential retry ${attempt} never converged`);
    };

    const SEQUENTIAL_RETRIES = 10_000;
    for (let attempt = 0; attempt < SEQUENTIAL_RETRIES; attempt += 1) {
      const replay = await replayOnce(attempt);
      if (replay.dealId !== first.dealId || !replay.replayed)
        throw new Error(
          `sequential retry ${attempt} diverged: dealId=${replay.dealId} replayed=${replay.replayed}`,
        );
    }
    // Transients are permitted by §22.4 but must not dominate; convergence is what matters.
    expect(transientRetries).toBeLessThan(SEQUENTIAL_RETRIES / 10);

    // Exactly one Deal, one idempotency identity, no duplicated domain effects.
    const sequentialScope = `PRINCIPAL:${sequentialInput.actorPrincipalId}`;
    const deals = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "Deal" WHERE "id"=$1`,
      [first.dealId],
    );
    expect(deals.rows[0]!.count).toBe(1);
    const claims = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
          WHERE "scope"=$1 AND "commandType"='CreateFormalDeal' AND "idempotencyKey"=$2`,
      [sequentialScope, sequentialInput.idempotencyKey],
    );
    expect(claims.rows[0]!.count).toBe(1);
    const effects = await pool.query<{
      revisions: number;
      slots: number;
      responses: number;
      events: number;
    }>(
      `SELECT
           (SELECT count(*)::int FROM "AgreementRevision" WHERE "dealId"=$1) AS revisions,
           (SELECT count(*)::int FROM "DealPartySlot" WHERE "dealId"=$1) AS slots,
           (SELECT count(*)::int FROM "RevisionResponse" WHERE "dealId"=$1) AS responses,
           (SELECT count(*)::int FROM "DealAgreementAuditEvent" WHERE "dealId"=$1) AS events`,
      [first.dealId],
    );
    expect(effects.rows[0]).toEqual({ revisions: 1, slots: 2, responses: 1, events: 3 });

    // ---- B. >=100 genuinely overlapping attempts BEFORE any winner exists ----
    // A fresh key/payload, launched together, so the real idempotency claim race is exercised
    // rather than a replay of an already-committed Deal.
    const CONCURRENT_ATTEMPTS = 120;
    const contendedInput = baseInput({ rawTerms: termsFor('Birth contention race') });
    const contended = await Promise.allSettled(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
        createFormalDeal(pool, productionKernelPorts, contendedInput),
      ),
    );

    const winners = contended.filter(
      (outcome) => outcome.status === 'fulfilled' && !outcome.value.replayed,
    );
    const replays = contended.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.replayed,
    );
    const losers = contended.filter((outcome) => outcome.status === 'rejected');

    // Exactly one attempt committed the Deal; everything else replayed it or failed safely.
    expect(winners).toHaveLength(1);
    const winnerDealId = (winners[0] as PromiseFulfilledResult<{ dealId: string }>).value.dealId;
    for (const replay of replays)
      expect((replay as PromiseFulfilledResult<{ dealId: string }>).value.dealId).toBe(
        winnerDealId,
      );
    for (const loser of losers) {
      const reason = (loser as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(Spec001Error);
      const code = (reason as Spec001Error).code;
      // Explicitly forbidden for same key + same fingerprint (§22.4 B).
      expect(code, 'same-key same-fingerprint must never conflict').not.toBe(
        'IDEMPOTENCY_CONFLICT',
      );
      expect(SAME_FINGERPRINT_LOSER_CODES.has(code), `unexpected loser code ${code}`).toBe(true);
    }

    // One Deal and one committed semantic meaning for the contended key.
    const contendedScope = `PRINCIPAL:${contendedInput.actorPrincipalId}`;
    const contendedClaims = await pool.query<{ count: number; outcomes: number }>(
      `SELECT count(*)::int AS count, count(DISTINCT "outcome"::text)::int AS outcomes
           FROM "ApplicationIdempotencyRecord"
          WHERE "scope"=$1 AND "commandType"='CreateFormalDeal' AND "idempotencyKey"=$2`,
      [contendedScope, contendedInput.idempotencyKey],
    );
    expect(contendedClaims.rows[0]!.count).toBe(1);
    expect(contendedClaims.rows[0]!.outcomes).toBe(1);
    const contendedDeals = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "Deal" WHERE "id"=$1`,
      [winnerDealId],
    );
    expect(contendedDeals.rows[0]!.count).toBe(1);
  }, 900_000);

  it('spec001_e03_create_key_payload_mutation', async () => {
    const input = baseInput();
    await createFormalDeal(pool, productionKernelPorts, input);
    // Same key, semantically different payload -> conflict, never a silent second meaning.
    expect(
      await codeOf(() =>
        createFormalDeal(pool, productionKernelPorts, {
          ...input,
          rawTerms: termsFor('A different contract title'),
        }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');

    // correlationId is excluded from the semantic fingerprint, so changing it still replays.
    const replay = await createFormalDeal(pool, productionKernelPorts, {
      ...input,
      correlationId: randomUUID(),
    });
    expect(replay.replayed).toBe(true);
  });

  it('spec001_e04_same_principal_both_sides', async () => {
    const actorPrincipalId = randomUUID();
    expect(
      await codeOf(() =>
        createFormalDeal(
          pool,
          productionKernelPorts,
          baseInput({
            actorPrincipalId,
            counterpartyTarget: { kind: 'PRINCIPAL', principalId: actorPrincipalId },
          }),
        ),
      ),
    ).toBe('SAME_PARTICIPANT_BOTH_SIDES');

    // The database independently forbids it, so the application check is not the only guard.
    const dealId = uuidV7();
    const revisionId = uuidV7();
    const principalId = randomUUID();
    const direct = await codeOfDirectSql(async (client) => {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "Deal" ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt","version","createdAt")
         VALUES ($1,$2,'GOODS',$3, now(), now() + interval '168 hours', 1, now())`,
        [dealId, dealReference(), revisionId],
      );
      await client.query(
        `INSERT INTO "AgreementRevision" ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint","createdAt")
         VALUES ($1,$2,1,NULL,$3,'dhamani.goods.v1','{}'::bytea,'{}'::bytea,decode(repeat('ab',32),'hex'),now())`,
        [revisionId, dealId, principalId],
      );
      await client.query(
        `INSERT INTO "DealPartySlot" ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
         VALUES ($1,$2,'GOODS','CREATOR','BUYER',$3,NULL,now(),now()),
                ($4,$2,'GOODS','COUNTERPARTY','SELLER',$3,NULL,now(),now())`,
        [uuidV7(), dealId, principalId, uuidV7()],
      );
      await client.query('COMMIT');
    });
    expect(direct).toMatch(/DealPartySlot_deal_principal_key|SPEC001_SAME_PRINCIPAL_BOTH_SIDES/);
  });

  it('spec001_e05_pending_counterparty_birth', async () => {
    const pendingInviteId = randomUUID();
    const result = await createFormalDeal(
      pool,
      productionKernelPorts,
      baseInput({ counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId } }),
    );
    const slots = await pool.query(
      `SELECT "slotKind"::text AS "slotKind","principalId","pendingInviteId","boundAt"
         FROM "DealPartySlot" WHERE "dealId"=$1`,
      [result.dealId],
    );
    expect(slots.rowCount).toBe(2);
    const counterparty = slots.rows.find((slot) => slot.slotKind === 'COUNTERPARTY')!;
    expect(counterparty.principalId).toBeNull();
    expect(counterparty.boundAt).toBeNull();
    expect(counterparty.pendingInviteId).toBe(pendingInviteId);

    // No raw PII is stored anywhere in the Deal kernel for the pending counterparty.
    const dump = JSON.stringify(slots.rows);
    expect(dump).not.toMatch(/@|\+\d{6,}/);
  });
});

function dealReference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const pick = () =>
    Array.from({ length: 4 }, () => alphabet.charAt(Math.floor(Math.random() * 32))).join('');
  return `DH-${pick()}-${pick()}-${pick()}`;
}

async function codeOfDirectSql(run: (client: pg.PoolClient) => Promise<void>): Promise<string> {
  const client = await pool.connect();
  try {
    await run(client);
    return 'NO_ERROR_THROWN';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.release();
  }
}
