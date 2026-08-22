import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LOCK_TIMEOUT_MS,
  SPEC001_TRANSACTION_OPTIONS,
  TRANSACTION_MAX_WAIT_MS,
  TRANSACTION_TIMEOUT_MS,
  withTransaction,
} from '../../../apps/api/src/spec001/database.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import { readDealByPublicReference } from '../../../apps/api/src/spec001/reads.ts';
import {
  auditEvents,
  bornDeal,
  dealRow,
  errorCodeOf,
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

/** Projections §22.5 forbids storing, plus obvious aliases the same value could hide behind. */
const FORBIDDEN_STORED_KEYS = [
  'agreementReady',
  'agreement_ready',
  'isAgreementReady',
  'ready',
  'readiness',
  'currentTerminationReason',
  'terminationReason',
  'terminatedAt',
  'currentRevisionId',
  'firstMutualAcceptedAt',
];

/** The only shapes §22.5 permits: IDs, revision number, result kind, command timestamp, typed error. */
const PERMITTED_STORED_KEYS = [
  'dealId',
  'revisionId',
  'revisionNumber',
  'dealVersion',
  'resultKind',
  'principalId',
  'predecessorRevisionId',
  'publicReference',
  'sentAt',
  'inviteExpiresAt',
  'typedErrorCode',
  'typedErrorDetails',
];

async function storedOutcomeFor(idempotencyKey: string): Promise<Record<string, unknown>> {
  const stored = await pool.query<{ outcome: Record<string, unknown>; outcomeKind: string }>(
    `SELECT "outcome","outcomeKind" FROM "ApplicationIdempotencyRecord" WHERE "idempotencyKey"=$1`,
    [idempotencyKey],
  );
  expect(stored.rowCount, 'exactly one stored idempotency record').toBe(1);
  return stored.rows[0]!.outcome;
}

describe('SPEC-001 remediation — §22.5 stored replay result', () => {
  it('spec001_stored_replay_outcome_has_no_live_projection', async () => {
    const deal = await bornDeal(pool, { title: 'Stored outcome shape' });
    const acceptKey = key();
    const accepted = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    // The command still reports readiness to its caller...
    expect(accepted.agreementReady).toBe(true);
    expect(accepted.firstMutualAcceptance).toBe(true);
    expect(accepted.resultKind).toBe('FIRST_MUTUAL_ACCEPTANCE_REACHED');

    // ...but what is PERSISTED contains no live-derived projection (§22.5, read from real
    // PostgreSQL rather than from the in-memory result).
    const outcome = await storedOutcomeFor(acceptKey);
    for (const forbidden of FORBIDDEN_STORED_KEYS)
      expect(Object.keys(outcome), `stored outcome must not persist ${forbidden}`).not.toContain(
        forbidden,
      );
    expect(JSON.stringify(outcome)).not.toMatch(/agreement[_ ]?ready/i);

    // Only Frozen-permitted immutable commit-time facts are stored.
    for (const stored of Object.keys(outcome))
      expect(PERMITTED_STORED_KEYS, `unexpected stored key ${stored}`).toContain(stored);
    expect(outcome.resultKind).toBe('FIRST_MUTUAL_ACCEPTANCE_REACHED');
    expect(outcome.dealId).toBe(deal.dealId);
    expect(outcome.revisionId).toBe(deal.revisionId);
    expect(outcome.dealVersion).toBe(2);

    // Every keyed command that committed here obeys the same rule.
    const all = await pool.query<{ outcome: Record<string, unknown> }>(
      `SELECT "outcome" FROM "ApplicationIdempotencyRecord" WHERE "outcomeKind"='SUCCESS'`,
    );
    expect(all.rowCount).toBeGreaterThan(0);
    for (const row of all.rows)
      for (const stored of Object.keys(row.outcome))
        expect(PERMITTED_STORED_KEYS, `unexpected stored key ${stored}`).toContain(stored);
  });

  it('spec001_stored_outcome_rejects_reintroduced_readiness_projection', () => {
    // Fail-closed guard: if `agreementReady` (or an alias) is ever put back into a stored outcome,
    // this fails without needing anyone to remember to re-check by hand.
    const commandSources = [
      'accept-current-revision.ts',
      'reject-current-revision.ts',
      'propose-changes.ts',
      'withdraw.ts',
      'bind-counterparty-principal.ts',
      'create-formal-deal.ts',
      'shared.ts',
    ];
    for (const file of commandSources) {
      const source = readFileSync(join('apps/api/src/spec001/commands', file), 'utf8');
      // Isolate each stored-facts / committed-facts payload and scan only that region.
      for (const marker of ['storedFacts: {', 'committedFacts = {']) {
        let index = source.indexOf(marker);
        while (index >= 0) {
          const region = source.slice(index, source.indexOf('}', index + marker.length));
          for (const forbidden of ['agreementReady', 'firstMutualAcceptance', 'terminatedAt'])
            expect(region, `${file} persists forbidden projection ${forbidden}`).not.toContain(
              forbidden,
            );
          index = source.indexOf(marker, index + 1);
        }
      }
    }
  });

  it('spec001_historical_replay_after_later_state_change_is_exact', async () => {
    const deal = await bornDeal(pool, { title: 'Historical replay exactness' });
    const acceptKey = key();
    const original = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    expect(original.agreementReady).toBe(true);
    expect(original.firstMutualAcceptance).toBe(true);

    // Move the Deal on: a successor makes the old readiness stale and advances currentRevisionId.
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Historical replay exactness', { v: 2 }),
      idempotencyKey: key(),
    });
    const before = await dealRow(pool, deal.dealId);
    const responsesBefore = await responseRows(pool, deal.dealId);
    const auditBefore = await auditEvents(pool, deal.dealId);

    // Replay the historical Accept. It must reproduce the ORIGINAL commit-time outcome.
    const replay = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.resultKind).toBe(original.resultKind);
    expect(replay.agreementReady).toBe(true);
    expect(replay.firstMutualAcceptance).toBe(true);
    expect(replay.dealVersion).toBe(original.dealVersion);
    // It reports the revision the ORIGINAL command acted on, never the newer current revision.
    expect(replay.revisionId).toBe(deal.revisionId);
    expect(replay.revisionId).not.toBe(successor.revisionId);

    // Nothing newer was mutated and nothing was duplicated.
    const after = await dealRow(pool, deal.dealId);
    expect(after.version).toBe(before.version);
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
    expect(after.currentRevisionId).toBe(successor.revisionId);
    expect(await responseRows(pool, deal.dealId)).toHaveLength(responsesBefore.length);
    const auditAfter = await auditEvents(pool, deal.dealId);
    expect(auditAfter).toEqual(auditBefore);
    expect(auditAfter.filter((event) => event === 'MUTUAL_ACCEPTANCE_REACHED')).toHaveLength(1);
    expect(auditAfter.filter((event) => event === 'REVISION_ACCEPTED_EXPLICIT')).toHaveLength(1);

    // The replay did not consult live state: the Deal is no longer ready, yet the historical
    // outcome still reports the readiness the original command committed.
    expect(await revisionRows(pool, deal.dealId)).toHaveLength(2);
  });
});

describe('SPEC-001 remediation — §23.1 Prisma transaction baseline', () => {
  it('spec001_authoritative_path_uses_frozen_prisma_transaction_baseline', async () => {
    // The frozen constants themselves. Any drift fails here.
    expect(SPEC001_TRANSACTION_OPTIONS).toEqual({
      isolationLevel: 'ReadCommitted',
      maxWait: 5000,
      timeout: 10_000,
    });
    expect(TRANSACTION_MAX_WAIT_MS).toBe(5000);
    expect(TRANSACTION_TIMEOUT_MS).toBe(10_000);
    expect(LOCK_TIMEOUT_MS).toBe(3000);

    // Instrument the REAL client the command path uses, then run a REAL command through it, so
    // this proves the authoritative path rather than a test helper that merely mirrors it.
    const captured: Array<Record<string, unknown>> = [];
    const prisma = pool.prisma as unknown as {
      $transaction: (...args: unknown[]) => Promise<unknown>;
    };
    const original = prisma.$transaction.bind(prisma);
    prisma.$transaction = (...args: unknown[]) => {
      if (args.length > 1 && typeof args[1] === 'object' && args[1] !== null)
        captured.push(args[1] as Record<string, unknown>);
      return original(...args);
    };
    try {
      const deal = await bornDeal(pool, { title: 'Transaction baseline' });
      await acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: key(),
      });
    } finally {
      prisma.$transaction = original as typeof prisma.$transaction;
    }

    expect(captured.length, 'commands must open Prisma interactive transactions').toBeGreaterThan(
      0,
    );
    for (const options of captured)
      expect(options).toEqual({
        isolationLevel: 'ReadCommitted',
        maxWait: 5000,
        timeout: 10_000,
      });

    // And the settings are genuinely in force inside the same transaction helper commands use.
    const observed = await withTransaction(pool, async (sql) => {
      const isolation = await sql.query<{ transaction_isolation: string }>(
        'SHOW transaction_isolation',
      );
      const lockTimeout = await sql.query<{ lock_timeout: string }>('SHOW lock_timeout');
      return {
        isolation: isolation.rows[0]!.transaction_isolation,
        lockTimeout: lockTimeout.rows[0]!.lock_timeout,
      };
    });
    expect(observed.isolation).toBe('read committed');
    expect(observed.lockTimeout).toBe('3s');
  });

  it('spec001_transaction_ordering_locks_before_time_and_reads', () => {
    // §23.1/§23.3 ordering is a property of the source: claim -> Deal FOR UPDATE lock ->
    // one clock_timestamp() -> authoritative reads. Asserting the order structurally means the
    // proof fails closed if a future edit moves the clock or the reads ahead of the lock.
    const shared = readFileSync('apps/api/src/spec001/commands/shared.ts', 'utf8');
    const claim = shared.indexOf('claimIdempotency(');
    const lock = shared.indexOf('lockDeal(');
    const clock = shared.indexOf('captureCommandTime(');
    const reads = shared.indexOf('loadDealSnapshot(');
    for (const [name, index] of [
      ['claimIdempotency', claim],
      ['lockDeal', lock],
      ['captureCommandTime', clock],
      ['loadDealSnapshot', reads],
    ] as const)
      expect(index, `${name} must appear in the keyed command pipeline`).toBeGreaterThan(-1);
    expect(claim, 'idempotency claim precedes the Deal row lock').toBeLessThan(lock);
    expect(lock, 'Deal row lock precedes the single clock_timestamp()').toBeLessThan(clock);
    expect(clock, 'commandTime is captured before authoritative reads').toBeLessThan(reads);

    // The lock really is a row lock.
    const repository = readFileSync('apps/api/src/spec001/repository.ts', 'utf8');
    expect(repository).toContain('FOR UPDATE');

    // The authoritative path is a Prisma interactive transaction, not a hand-rolled one.
    const database = readFileSync('apps/api/src/spec001/database.ts', 'utf8');
    expect(database).toContain('this.prisma.$transaction(');
    expect(database).toContain('SPEC001_TRANSACTION_OPTIONS');
    expect(database).toContain('SET LOCAL lock_timeout');
    // A bare BEGIN would mean the Prisma transaction baseline had been bypassed.
    expect(database).not.toContain("'BEGIN ISOLATION LEVEL");
  });

  it('spec001_public_reference_is_not_an_existence_oracle', async () => {
    // §28 — the reference lookup lives behind the authorization boundary and `publicReference`
    // alone is never authorization. An outsider must therefore be unable to tell a real Deal
    // reference from an invented one through this application service.
    const deal = await bornDeal(pool, { title: 'Reference oracle probe' });
    const outsider = { kind: 'PARTICIPANT' as const, principalId: randomUUID() };

    const invented = 'DH-2222-3333-4444';
    const realReferenceAnswer = await errorCodeOf(() =>
      readDealByPublicReference(pool, ports, outsider, deal.publicReference),
    );
    const inventedReferenceAnswer = await errorCodeOf(() =>
      readDealByPublicReference(pool, ports, outsider, invented),
    );

    // Identical answers: existence cannot be probed by a non-participant.
    expect(realReferenceAnswer).toBe('NOT_DEAL_PARTICIPANT');
    expect(inventedReferenceAnswer).toBe('NOT_DEAL_PARTICIPANT');
    expect(inventedReferenceAnswer).toBe(realReferenceAnswer);

    // A bound participant still reads their own Deal by reference.
    const asParticipant = await readDealByPublicReference(
      pool,
      ports,
      { kind: 'PARTICIPANT', principalId: deal.counterpartyId },
      deal.publicReference,
    );
    expect(asParticipant.dealId).toBe(deal.dealId);

    // A named trusted internal scope is authorized to learn the difference.
    expect(
      await errorCodeOf(() =>
        readDealByPublicReference(
          pool,
          ports,
          { kind: 'TRUSTED_SYSTEM', purpose: 'reference-audit' },
          invented,
        ),
      ),
    ).toBe('DEAL_NOT_FOUND');
  });
});
