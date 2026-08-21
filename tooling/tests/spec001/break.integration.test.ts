import { afterAll, describe, expect, it } from 'vitest';
import { Spec001Error } from '../../../packages/domain/src/index.ts';
import {
  LOCK_TIMEOUT_MS,
  TRANSACTION_TIMEOUT_MS,
  createKernelDatabase,
  withTransaction,
  isRetryableDatabaseError,
  isUniqueViolation,
  mapDatabaseError,
  Spec001PersistenceFailure,
} from '../../../apps/api/src/spec001/database.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import {
  bornDeal,
  dealRow,
  requireConnectionString,
  errorCodeOf,
  errorOf,
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

describe('SPEC-001 adversarial break probes', () => {
  it('spec001_lock_wait_timeout_maps_to_retryable', async () => {
    const deal = await bornDeal(pool, { title: 'Lock timeout' });
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT * FROM "Deal" WHERE "id"=$1 FOR UPDATE', [deal.dealId]);

      // The command must wait on the Deal row lock, hit the 3000 ms lock_timeout, and surface the
      // stable retryable contract rather than a raw SQLSTATE 57014.
      const started = Date.now();
      const failure = await errorOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      );
      const elapsed = Date.now() - started;
      expect(failure).toBeInstanceOf(Spec001Error);
      expect(failure?.code).toBe('DEAL_WRITE_RETRYABLE');
      expect(elapsed).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 200);

      // The timed-out attempt committed nothing and released its idempotency claim.
      await blocker.query('ROLLBACK');
      const row = await dealRow(pool, deal.dealId);
      expect(row.version).toBe(1);
      expect(await responseRows(pool, deal.dealId)).toHaveLength(1);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    // Retrying the same semantic command after the lock is released succeeds normally.
    const retried = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    expect(retried.agreementReady).toBe(true);
  }, 60_000);

  it('spec001_unique_violations_map_to_specific_frozen_codes', () => {
    // A unique violation must not collapse into one generic code: each constraint carries a
    // distinct, frozen §27 meaning.
    const violation = (constraint: string): Spec001Error => {
      const mapped = mapDatabaseError(
        Object.assign(new Error('duplicate key'), { code: '23505', constraint }),
      );
      expect(mapped).toBeInstanceOf(Spec001Error);
      return mapped as Spec001Error;
    };

    expect(violation('RevisionResponse_revision_principal_key').code).toBe(
      'REVISION_ALREADY_RESPONDED',
    );
    expect(violation('AgreementRevision_deal_number_key').code).toBe('REVISION_SEQUENCE_CONFLICT');
    expect(violation('DealPartySlot_deal_principal_key').code).toBe('SAME_PARTICIPANT_BOTH_SIDES');
    expect(violation('ApplicationIdempotencyRecord_claim_key').code).toBe(
      'IDEMPOTENT_REQUEST_IN_PROGRESS',
    );
    // An UNRECOGNISED unique constraint is neither falsely relabelled nor allowed to escape as
    // the original pg/Prisma object.
    const unknownUniqueRaw = Object.assign(new Error('duplicate raw detail'), {
      code: '23505',
      constraint: 'some_future_constraint',
    });
    const unknownUnique = mapDatabaseError(unknownUniqueRaw);
    expect(unknownUnique).toBeInstanceOf(Spec001PersistenceFailure);
    expect(unknownUnique).not.toBeInstanceOf(Spec001Error);
    expect(unknownUnique).not.toBe(unknownUniqueRaw);
    expect(unknownUnique.message).toBe('SPEC001_INTERNAL_PERSISTENCE_FAILURE');
    expect(unknownUnique.message).not.toContain('23505');
    expect(unknownUnique.cause).toBe(unknownUniqueRaw);

    // SQLSTATEs with an exclusive Frozen meaning map to the retryable contract.
    for (const code of ['40001', '40P01', '55P03']) {
      const mapped = mapDatabaseError(Object.assign(new Error('transient'), { code }));
      expect(mapped).toBeInstanceOf(Spec001Error);
      expect((mapped as Spec001Error).code, code).toBe('DEAL_WRITE_RETRYABLE');
      expect(isRetryableDatabaseError({ code })).toBe(true);
    }
    for (const message of [
      'canceling statement due to lock timeout',
      'canceling statement due to statement timeout',
    ]) {
      const failure = { code: '57014', message };
      expect(isRetryableDatabaseError(failure)).toBe(true);
      expect((mapDatabaseError(failure) as Spec001Error).code).toBe('DEAL_WRITE_RETRYABLE');
    }
    expect(isRetryableDatabaseError({ code: 'P2034' })).toBe(true);
    expect((mapDatabaseError({ code: 'P2034' }) as Spec001Error).code).toBe('DEAL_WRITE_RETRYABLE');
    const timedOutTransaction = {
      code: 'P2028',
      message: 'Transaction already closed: timeout for this transaction was 10000 ms',
    };
    expect(isRetryableDatabaseError(timedOutTransaction)).toBe(true);
    expect((mapDatabaseError(timedOutTransaction) as Spec001Error).code).toBe(
      'DEAL_WRITE_RETRYABLE',
    );

    // These broad codes do not acquire retryable semantics merely from their classification.
    for (const failure of [
      { code: '25P02', message: 'current transaction is aborted' },
      { code: '08000', message: 'connection exception' },
      { code: '08003', message: 'connection does not exist' },
      { code: '08006', message: 'connection failure' },
      { code: 'P2024', message: 'timed out fetching a pool connection' },
      { code: 'P2028', message: 'Transaction API error: transaction not found' },
      { code: '57014', message: 'canceling statement due to user request' },
    ]) {
      expect(isRetryableDatabaseError(failure), String(failure.code)).toBe(false);
      expect(mapDatabaseError(failure), String(failure.code)).toBeInstanceOf(
        Spec001PersistenceFailure,
      );
    }

    // Unknown SQLSTATE and Prisma/adapter failures share the same clean boundary. Raw diagnostics
    // survive only as the internal cause, never in the stable outward message.
    for (const raw of [
      Object.assign(new Error('raw check violation'), { code: '23514' }),
      Object.assign(new Error('raw prisma adapter detail'), { code: 'P9999' }),
      Object.assign(new Error('unshaped persistence detail'), { adapter: 'future' }),
    ]) {
      const boundary = mapDatabaseError(raw);
      expect(boundary).toBeInstanceOf(Spec001PersistenceFailure);
      expect(boundary).not.toBe(raw);
      expect(boundary.message).toBe('SPEC001_INTERNAL_PERSISTENCE_FAILURE');
      expect(boundary.message).not.toMatch(/23514|P9999|raw/i);
      expect(boundary.cause).toBe(raw);
    }

    // A domain error passes through unchanged rather than being re-wrapped.
    const domain = new Spec001Error('REVISION_NOT_CURRENT', { expectedRevisionId: 'x' });
    expect(mapDatabaseError(domain)).toBe(domain);

    // Constraint matching is exact, so an unrelated unique violation is not misattributed.
    expect(
      isUniqueViolation(
        { code: '23505', constraint: 'Deal_publicReference_key' },
        'Deal_publicReference_key',
      ),
    ).toBe(true);
    expect(
      isUniqueViolation({ code: '23505', constraint: 'other' }, 'Deal_publicReference_key'),
    ).toBe(false);
    expect(isUniqueViolation({ code: '23503' }, 'Deal_publicReference_key')).toBe(false);
  });

  it('spec001_cross_participant_and_cross_deal_commands_are_refused', async () => {
    const dealA = await bornDeal(pool, { title: 'Cross deal A' });
    const dealB = await bornDeal(pool, { title: 'Cross deal B' });

    // An outsider Principal cannot act on a Deal they are not bound to.
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: randomUUID(),
          correlationId: randomUUID(),
          dealId: dealA.dealId,
          targetRevisionId: dealA.revisionId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('NOT_DEAL_PARTICIPANT');

    // A participant of another Deal is equally an outsider here.
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: dealB.counterpartyId,
          correlationId: randomUUID(),
          dealId: dealA.dealId,
          targetRevisionId: dealA.revisionId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('NOT_DEAL_PARTICIPANT');

    // A base revision belonging to another Deal is not found for this Deal.
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: dealA.counterpartyId,
          correlationId: randomUUID(),
          dealId: dealA.dealId,
          baseRevisionId: dealB.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Cross deal A', { v: 2 }),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('REVISION_NOT_FOUND');

    // An unknown Deal id is refused before anything else happens.
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: dealA.counterpartyId,
          correlationId: randomUUID(),
          dealId: randomUUID(),
          targetRevisionId: dealA.revisionId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('DEAL_NOT_FOUND');

    // Neither Deal moved.
    for (const deal of [dealA, dealB]) {
      const row = await dealRow(pool, deal.dealId);
      expect(row.version).toBe(1);
      expect(await revisionRows(pool, deal.dealId)).toHaveLength(1);
    }
  });

  it('spec001_malformed_and_hostile_terms_never_reserve_a_key', async () => {
    const actorPrincipalId = randomUUID();
    const hostile: Array<[string, Uint8Array]> = [
      ['duplicate keys', new TextEncoder().encode('{"common":{"title":"abc"},"common":{}}')],
      ['truncated json', new TextEncoder().encode('{"common":{"title":"abc"}')],
      [
        'nul in string',
        new TextEncoder().encode('{"common":{"title":"a\\u0000bc"},"typeTerms":{}}'),
      ],
      [
        'lone surrogate',
        new TextEncoder().encode('{"common":{"title":"a\\ud800bc"},"typeTerms":{}}'),
      ],
      [
        'bad number',
        new TextEncoder().encode('{"common":{"title":"abc"},"typeTerms":{"n":1e999}}'),
      ],
      ['invalid utf-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    ];
    for (const [name, rawTerms] of hostile) {
      const idempotencyKey = key();
      const code = await errorCodeOf(() =>
        import('../../../apps/api/src/spec001/commands/create-formal-deal.ts').then((module) =>
          module.createFormalDeal(pool, ports, {
            actorPrincipalId,
            correlationId: randomUUID(),
            dealType: 'GOODS',
            creatorRole: 'BUYER',
            counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms,
            idempotencyKey,
          }),
        ),
      );
      expect(code, name).toMatch(
        /^(TERMS_JSON_[A-Z_]+|INVALID_TERMS_ENVELOPE|TERMS_PAYLOAD_TOO_LARGE)$/,
      );
      // No key is reserved by a pre-fingerprint failure (§22.2).
      const claims = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
          WHERE "scope"=$1 AND "idempotencyKey"=$2`,
        [`PRINCIPAL:${actorPrincipalId}`, idempotencyKey],
      );
      expect(claims.rows[0]!.count, name).toBe(0);
    }
  });

  it('spec001_transaction_timeout_maps_to_retryable', async () => {
    // The frozen §23.1 interactive-transaction timeout must actually abort work that overruns it,
    // and must surface as the stable retryable contract rather than a raw Prisma error.
    const started = Date.now();
    let code = 'NO_ERROR_THROWN';
    try {
      await withTransaction(pool, async (sql) => {
        // Cast away pg_sleep's void return so the probe fails on the timeout, not on decoding.
        await sql.query(`SELECT pg_sleep(${(TRANSACTION_TIMEOUT_MS / 1000) * 2})::text AS slept`);
      });
    } catch (error) {
      code = error instanceof Spec001Error ? error.code : `UNEXPECTED:${String(error)}`;
      if (!(error instanceof Spec001Error)) {
        const mapped = mapDatabaseError(error);
        code = mapped instanceof Spec001Error ? mapped.code : `UNEXPECTED:${mapped.name}`;
      }
    }
    expect(code).toBe('DEAL_WRITE_RETRYABLE');
    // It was interrupted at roughly the configured timeout rather than running to completion.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TRANSACTION_TIMEOUT_MS - 1000);
    expect(elapsed).toBeLessThan(TRANSACTION_TIMEOUT_MS * 1.8);
  }, 120_000);

  it('spec001_same_key_replay_after_reconnect_returns_original_outcome', async () => {
    const deal = await bornDeal(pool, { title: 'Reconnect replay' });
    const acceptKey = key();
    const original = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });

    // A completely fresh client/connection pool, as a restarted service would have.
    const reconnected = createKernelDatabase(requireConnectionString());
    try {
      const replay = await acceptCurrentRevision(reconnected, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: acceptKey,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.resultKind).toBe(original.resultKind);
      expect(replay.dealVersion).toBe(original.dealVersion);
      expect(replay.revisionId).toBe(original.revisionId);
    } finally {
      await reconnected.end();
    }
    // No duplicate effect survived the reconnect.
    expect(await responseRows(pool, deal.dealId)).toHaveLength(2);
    expect((await dealRow(pool, deal.dealId)).version).toBe(2);
  });
});
