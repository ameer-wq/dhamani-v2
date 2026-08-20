import { afterAll, describe, expect, it } from 'vitest';
import { Spec001Error } from '../../../packages/domain/src/index.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import { rejectCurrentRevision } from '../../../apps/api/src/spec001/commands/reject-current-revision.ts';
import { withdrawInvitation } from '../../../apps/api/src/spec001/commands/withdraw.ts';
import {
  auditEvents,
  bornDeal,
  dealRow,
  ownerPool,
  ports,
  randomUUID,
  responseRows,
  revisionRows,
  terms,
} from './helpers.ts';

const pool = ownerPool();

afterAll(async () => {
  await pool.end();
});

const key = () => randomUUID();

/**
 * Permitted loser outcomes are declared per scenario, never as one broad set.
 *
 * A generic allowlist would accept codes that cannot logically arise in a given race and would
 * therefore hide a regression behind a green test. In particular `IDEMPOTENCY_CONFLICT` is only
 * legal for a *different* fingerprint under the same key (§22.4 B), so it never belongs in a
 * same-semantic contention scenario.
 */

/** Transport-level outcomes §22.4(D)/(E) permit in any real race. */
const CONTENTION_TRANSIENTS = ['DEAL_WRITE_RETRYABLE', 'IDEMPOTENT_REQUEST_IN_PROGRESS'] as const;

/** E10 — withdraw vs accept on R1: whichever loses sees the other's committed progression. */
const E10_LOSER_CODES = new Set<string>([
  'DEAL_TERMINATED', // accept lost to the withdrawal
  'WITHDRAW_NOT_ALLOWED', // withdrawal lost to the counterparty's contractual response
  ...CONTENTION_TRANSIENTS,
]);

/** E15 — two successors from the same base by the same actor. */
const E15_LOSER_CODES = new Set<string>([
  'REVISION_NOT_CURRENT', // base is no longer current
  'ACTOR_MUST_WAIT_FOR_COUNTERPARTY', // the actor now authored the current revision
  ...CONTENTION_TRANSIENTS,
]);

/** §23.5 — same actor, DIFFERENT keys: the loser gets a deterministic already-responded/
 *  current-state conflict, not an arbitrary error. */
const E21_DIFFERENT_KEY_LOSER_CODES = new Set<string>([
  'REVISION_ALREADY_RESPONDED',
  'REVISION_NOT_CURRENT',
  ...CONTENTION_TRANSIENTS,
]);

/** §22.4(B) — same key AND same fingerprint: a conflict is forbidden. */
const SAME_FINGERPRINT_LOSER_CODES = new Set<string>([...CONTENTION_TRANSIENTS]);

/** E39 — four conflicting commands against the same prior state. */
const E39_LOSER_CODES = new Set<string>([
  'DEAL_TERMINATED',
  'REVISION_NOT_CURRENT',
  'REVISION_ALREADY_RESPONDED',
  'WITHDRAW_NOT_ALLOWED',
  'ACTOR_MUST_WAIT_FOR_COUNTERPARTY',
  ...CONTENTION_TRANSIENTS,
]);

function classify(results: PromiseSettledResult<unknown>[]): {
  winners: number;
  loserCodes: string[];
} {
  const loserCodes: string[] = [];
  let winners = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') winners += 1;
    else {
      expect(result.reason, 'losers must fail with a typed domain error').toBeInstanceOf(
        Spec001Error,
      );
      loserCodes.push((result.reason as Spec001Error).code);
    }
  }
  return { winners, loserCodes };
}

/**
 * Installs a real BEFORE INSERT failure into the audit table for one sentinel correlationId.
 *
 * The sentinel is baked into the function body rather than read from a session GUC: pooled
 * connections opened before an `ALTER DATABASE ... SET` never observe that setting, which would
 * silently turn this injection into a no-op and make the test pass for the wrong reason.
 */
async function installAuditFailureTrigger(sentinel: string): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION spec001_test_audit_failure() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."correlationId"::text = '${sentinel}' THEN
        RAISE EXCEPTION 'INJECTED_AUDIT_FAILURE';
      END IF;
      RETURN NEW;
    END; $$;`);
  await pool.query(`
    CREATE TRIGGER "DealAgreementAuditEvent_test_failure"
      BEFORE INSERT ON "DealAgreementAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION spec001_test_audit_failure();`);
  await pool.query(
    'ALTER TABLE "DealAgreementAuditEvent" ENABLE ALWAYS TRIGGER "DealAgreementAuditEvent_test_failure"',
  );
}

async function removeAuditFailureTrigger(): Promise<void> {
  await pool
    .query(
      'DROP TRIGGER IF EXISTS "DealAgreementAuditEvent_test_failure" ON "DealAgreementAuditEvent"',
    )
    .catch(() => undefined);
  await pool.query('DROP FUNCTION IF EXISTS spec001_test_audit_failure()').catch(() => undefined);
}

describe('SPEC-001 concurrency with real overlapping transactions', () => {
  it('spec001_e10_r1_withdraw_accept_race', async () => {
    for (let round = 0; round < 5; round += 1) {
      const deal = await bornDeal(pool);
      const results = await Promise.allSettled([
        withdrawInvitation(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      ]);
      const { winners, loserCodes } = classify(results);
      // Exactly one authoritative progression: the Deal is either withdrawn or accepted.
      expect(winners).toBe(1);
      for (const code of loserCodes)
        expect(E10_LOSER_CODES.has(code), `E10 loser code ${code}`).toBe(true);

      const row = await dealRow(pool, deal.dealId);
      const withdrew = row.terminationReason === 'INVITATION_WITHDRAWN';
      const accepted = row.firstMutualAcceptedAt !== null;
      // The two outcomes are mutually exclusive; no incompatible combination can commit.
      expect(withdrew !== accepted).toBe(true);
      expect(row.version).toBe(2);
    }
  });

  it('spec001_e15_concurrent_successor_no_fork', async () => {
    for (let round = 0; round < 5; round += 1) {
      const deal = await bornDeal(pool, { title: `Fork probe ${round}` });
      // Both proposals share the same base revision and are issued by the authorized actor.
      const results = await Promise.allSettled([
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms(`Fork probe ${round}`, { branch: 'a' }),
          idempotencyKey: key(),
        }),
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms(`Fork probe ${round}`, { branch: 'b' }),
          idempotencyKey: key(),
        }),
      ]);
      const { winners, loserCodes } = classify(results);
      expect(winners).toBe(1);
      for (const code of loserCodes)
        expect(E15_LOSER_CODES.has(code), `E15 loser code ${code}`).toBe(true);

      const revisions = await revisionRows(pool, deal.dealId);
      // Exactly one successor exists: the chain is linear and never forks.
      expect(revisions).toHaveLength(2);
      expect(revisions[1]!.revisionNumber).toBe(2);
      expect(revisions[1]!.predecessorRevisionId).toBe(deal.revisionId);
      const row = await dealRow(pool, deal.dealId);
      expect(row.currentRevisionId).toBe(revisions[1]!.id);
      expect(row.version).toBe(2);
    }
  });

  it('spec001_e21_awaited_accept_concurrent_double_submit', async () => {
    // Variant 1: the same awaited participant submits overlapping Accepts under the SAME key.
    for (let round = 0; round < 3; round += 1) {
      const deal = await bornDeal(pool);
      const sharedKey = key();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          acceptCurrentRevision(pool, ports, {
            actorPrincipalId: deal.counterpartyId,
            correlationId: randomUUID(),
            dealId: deal.dealId,
            targetRevisionId: deal.revisionId,
            idempotencyKey: sharedKey,
          }),
        ),
      );
      const { loserCodes } = classify(results);
      for (const code of loserCodes) {
        // §22.4(B): same key + same fingerprint must never be reported as a conflict.
        expect(code, 'same-key same-fingerprint must never conflict').not.toBe(
          'IDEMPOTENCY_CONFLICT',
        );
        expect(SAME_FINGERPRINT_LOSER_CODES.has(code), `E21 same-key loser code ${code}`).toBe(
          true,
        );
      }

      const responses = await responseRows(pool, deal.dealId);
      // Exactly one explicit response and exactly one readiness event.
      expect(responses.filter((row) => row.responseOrigin === 'EXPLICIT')).toHaveLength(1);
      const events = await auditEvents(pool, deal.dealId);
      expect(events.filter((event) => event === 'MUTUAL_ACCEPTANCE_REACHED')).toHaveLength(1);
      expect(events.filter((event) => event === 'REVISION_ACCEPTED_EXPLICIT')).toHaveLength(1);
      const row = await dealRow(pool, deal.dealId);
      expect(row.version).toBe(2);
      expect(row.firstMutualAcceptedAt).not.toBeNull();
    }

    // Variant 2: the same participant submits overlapping Accepts under DIFFERENT keys. The
    // loser must get a deterministic already-responded/current-state conflict.
    for (let round = 0; round < 3; round += 1) {
      const deal = await bornDeal(pool);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          acceptCurrentRevision(pool, ports, {
            actorPrincipalId: deal.counterpartyId,
            correlationId: randomUUID(),
            dealId: deal.dealId,
            targetRevisionId: deal.revisionId,
            idempotencyKey: key(),
          }),
        ),
      );
      const { winners, loserCodes } = classify(results);
      expect(winners).toBe(1);
      // §23.5 — the loser receives a deterministic already-responded/current-state conflict.
      for (const code of loserCodes)
        expect(
          E21_DIFFERENT_KEY_LOSER_CODES.has(code),
          `E21 different-key loser code ${code}`,
        ).toBe(true);

      const responses = await responseRows(pool, deal.dealId);
      expect(responses.filter((row) => row.responseOrigin === 'EXPLICIT')).toHaveLength(1);
      const events = await auditEvents(pool, deal.dealId);
      // Exactly one firstMutualAcceptedAt write.
      expect(events.filter((event) => event === 'MUTUAL_ACCEPTANCE_REACHED')).toHaveLength(1);
      expect((await dealRow(pool, deal.dealId)).version).toBe(2);
    }
  });

  it('spec001_e39_four_way_conflicting_action_race', async () => {
    for (let round = 0; round < 5; round += 1) {
      const deal = await bornDeal(pool, { title: `Four way ${round}` });
      // Four valid-but-conflicting commands issued against the same prior state.
      const results = await Promise.allSettled([
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
        rejectCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms(`Four way ${round}`, { proposed: true }),
          idempotencyKey: key(),
        }),
        withdrawInvitation(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      ]);
      const { winners, loserCodes } = classify(results);
      for (const code of loserCodes)
        expect(E39_LOSER_CODES.has(code), `E39 loser code ${code}`).toBe(true);

      const row = await dealRow(pool, deal.dealId);
      const revisions = await revisionRows(pool, deal.dealId);
      const terminal = row.terminationReason !== null;
      const advanced = row.currentRevisionId !== deal.revisionId;
      const everReady = row.firstMutualAcceptedAt !== null;

      // The commands serialize into ONE authoritative progression. Reject and WithdrawInvitation
      // are terminal and exclude everything else, so at most two of these four can commit — and
      // only the lawful Accept-then-Propose sequence, which §17.2 permits once the current
      // revision is mutually accepted.
      expect(winners).toBeGreaterThanOrEqual(1);
      expect(winners).toBeLessThanOrEqual(2);
      // §23.4 — exactly one version increment per successful command, and no others.
      expect(row.version).toBe(1 + winners);

      // No incompatible combination: a terminated Deal never also advanced its revision.
      expect(terminal && advanced).toBe(false);
      if (terminal) expect(revisions).toHaveLength(1);
      if (winners === 2) {
        expect(everReady).toBe(true);
        expect(advanced).toBe(true);
        expect(terminal).toBe(false);
        expect(revisions).toHaveLength(2);
        expect(revisions[1]!.predecessorRevisionId).toBe(deal.revisionId);
      }
    }
  });

  it('spec001_writes_are_deal_scoped_not_global_lock', async () => {
    // Independent Deals must progress concurrently: a Deal-scoped row lock, never a global one.
    const held = await bornDeal(pool);
    const other = await bornDeal(pool);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      // Hold an exclusive row lock on one Deal for the duration.
      await blocker.query('SELECT * FROM "Deal" WHERE "id"=$1 FOR UPDATE', [held.dealId]);

      // A command against a *different* Deal must still commit while that lock is held.
      const started = Date.now();
      const accepted = await acceptCurrentRevision(pool, ports, {
        actorPrincipalId: other.counterpartyId,
        correlationId: randomUUID(),
        dealId: other.dealId,
        targetRevisionId: other.revisionId,
        idempotencyKey: key(),
      });
      const elapsed = Date.now() - started;
      expect(accepted.agreementReady).toBe(true);
      // It must not have waited on the other Deal's lock (lock_timeout is 3000 ms).
      expect(elapsed).toBeLessThan(2000);

      // Many independent Deals also progress together rather than serializing behind one lock.
      const independent = await Promise.all(Array.from({ length: 8 }, () => bornDeal(pool)));
      const batchStarted = Date.now();
      const batch = await Promise.all(
        independent.map((deal) =>
          acceptCurrentRevision(pool, ports, {
            actorPrincipalId: deal.counterpartyId,
            correlationId: randomUUID(),
            dealId: deal.dealId,
            targetRevisionId: deal.revisionId,
            idempotencyKey: key(),
          }),
        ),
      );
      expect(batch.every((result) => result.agreementReady)).toBe(true);
      expect(Date.now() - batchStarted).toBeLessThan(5000);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('spec001_domain_write_and_audit_commit_atomically', async () => {
    const deal = await bornDeal(pool);
    const before = await dealRow(pool, deal.dealId);
    const sentinel = randomUUID();

    // Inject a real failure into the audit insert of the live command path: a trigger that
    // raises for one sentinel correlationId. The domain write must roll back with it.
    await installAuditFailureTrigger(sentinel);
    try {
      let failed = false;
      try {
        await acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: sentinel,
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      // The response row, the version increment and the idempotency success all rolled back.
      const after = await dealRow(pool, deal.dealId);
      expect(after.version).toBe(before.version);
      expect(after.firstMutualAcceptedAt).toBeNull();
      const responses = await responseRows(pool, deal.dealId);
      expect(responses.filter((row) => row.responseOrigin === 'EXPLICIT')).toHaveLength(0);
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  it('spec001_e32_successor_failure_rollback', async () => {
    const deal = await bornDeal(pool, { title: 'Successor rollback' });
    // Establish a real committed successor first so credits and history are non-trivial.
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Successor rollback', { round: 1 }),
      idempotencyKey: key(),
    });
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.creatorId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: successor.revisionId,
      idempotencyKey: key(),
    });
    const before = await dealRow(pool, deal.dealId);
    const revisionsBefore = await revisionRows(pool, deal.dealId);

    const sentinel = randomUUID();
    await installAuditFailureTrigger(sentinel);
    try {
      let failed = false;
      try {
        await proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: sentinel,
          dealId: deal.dealId,
          baseRevisionId: successor.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Successor rollback', { round: 2 }),
          idempotencyKey: key(),
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      // Prior current revision, history and credits are all unchanged.
      const after = await dealRow(pool, deal.dealId);
      expect(after.currentRevisionId).toBe(before.currentRevisionId);
      expect(after.version).toBe(before.version);
      expect(await revisionRows(pool, deal.dealId)).toHaveLength(revisionsBefore.length);

      // The failed attempt consumed no credit: the participant can still commit a successor.
      const retry = await proposeChanges(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        baseRevisionId: successor.revisionId,
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Successor rollback', { round: 3 }),
        idempotencyKey: key(),
      });
      expect(retry.revisionNumber).toBe(3);
    } finally {
      await removeAuditFailureTrigger();
    }
  });
});
