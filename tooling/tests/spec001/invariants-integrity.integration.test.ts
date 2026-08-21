import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { resolveRuntimeConfig } from '../../../packages/config/src/index.ts';
import { createApi } from '../../../apps/api/src/bootstrap.ts';
import {
  MAX_RAW_BYTES,
  Spec001Error,
  TITLE_MAX_CODE_POINTS,
} from '../../../packages/domain/src/index.ts';
import {
  createKernelDatabase,
  type KernelDatabase,
} from '../../../apps/api/src/spec001/database.ts';
import { uuidV7 } from '../../../apps/api/src/spec001/crypto.ts';
import { createFormalDeal } from '../../../apps/api/src/spec001/commands/create-formal-deal.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { bindCounterpartyPrincipal } from '../../../apps/api/src/spec001/commands/bind-counterparty-principal.ts';
import { expireInvitationIfDue } from '../../../apps/api/src/spec001/commands/expire-invitation-if-due.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import { rejectCurrentRevision } from '../../../apps/api/src/spec001/commands/reject-current-revision.ts';
import {
  withdrawInvitation,
  withdrawNegotiation,
} from '../../../apps/api/src/spec001/commands/withdraw.ts';
import { readDeal, readDealByPublicReference } from '../../../apps/api/src/spec001/reads.ts';
import {
  auditEvents,
  backdateInvitation,
  bornDeal,
  corruptRevisionBytes,
  dealRow,
  errorCodeOf,
  errorOf,
  ownerPool,
  ports,
  randomUUID,
  responseRows,
  revisionRows,
  runtimeConnectionString,
  terms,
} from './helpers.ts';

const pool = ownerPool();
let runtime: KernelDatabase;

beforeAll(async () => {
  await pool.query(
    `DO $$ BEGIN EXECUTE format('ALTER ROLE dhamani_runtime LOGIN PASSWORD %L','runtime_test_only'); END $$;`,
  );
  // Must resolve through the shared helper: it targets the provisioned SPEC-001 evidence
  // database, not whatever DATABASE_URL happens to point at.
  runtime = createKernelDatabase(runtimeConnectionString());
});

afterAll(async () => {
  await runtime?.end();
  await pool.end();
});

const key = () => randomUUID();

describe('SPEC-001 integrity, idempotency and security invariants', () => {
  it('spec001_terms_envelope_is_bounded_and_schema_bound', async () => {
    const create = (rawTerms: Uint8Array, termsSchemaId = 'dhamani.goods.v1') =>
      createFormalDeal(pool, ports, {
        actorPrincipalId: randomUUID(),
        correlationId: randomUUID(),
        dealType: 'GOODS',
        creatorRole: 'BUYER',
        counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
        termsSchemaId,
        rawTerms,
        idempotencyKey: key(),
      });

    // Closed top level.
    expect(
      await errorCodeOf(() =>
        create(new TextEncoder().encode('{"common":{"title":"X1Y"},"typeTerms":{},"extra":1}')),
      ),
    ).toBe('INVALID_TERMS_ENVELOPE');
    // Closed common object.
    expect(
      await errorCodeOf(() =>
        create(new TextEncoder().encode('{"common":{"title":"X1Y","nope":1},"typeTerms":{}}')),
      ),
    ).toBe('INVALID_TERMS_ENVELOPE');
    // typeTerms must be an object.
    expect(
      await errorCodeOf(() =>
        create(new TextEncoder().encode('{"common":{"title":"X1Y"},"typeTerms":[]}')),
      ),
    ).toBe('INVALID_TERMS_ENVELOPE');
    // Title bounds, counted in Unicode code points.
    expect(
      await errorCodeOf(() =>
        create(new TextEncoder().encode('{"common":{"title":"ab"},"typeTerms":{}}')),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      await errorCodeOf(() =>
        create(
          new TextEncoder().encode(
            JSON.stringify({
              common: { title: 'x'.repeat(TITLE_MAX_CODE_POINTS + 1) },
              typeTerms: {},
            }),
          ),
        ),
      ),
    ).toBe('VALIDATION_ERROR');
    // Whitespace-only titles fail the non-whitespace requirement.
    expect(
      await errorCodeOf(() =>
        create(new TextEncoder().encode('{"common":{"title":"   "},"typeTerms":{}}')),
      ),
    ).toBe('VALIDATION_ERROR');
    // Canonical cap is enforced by the database as well as by validation.
    const cap = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname='AgreementRevision_canonical_terms_cap_check'`,
    );
    expect(cap.rows[0]!.definition).toContain('65536');
    // Schema binding.
    expect(await errorCodeOf(() => create(terms('Schema bound'), 'nope.v1'))).toBe(
      'UNSUPPORTED_TERMS_SCHEMA',
    );
  });

  it('spec001_raw_terms_cap_rejects_before_decode', async () => {
    // The payload is BOTH oversized and syntactically invalid JSON. If the raw cap did not run
    // strictly before decode, the failure would surface as an envelope/parse error instead.
    const oversized = new Uint8Array(MAX_RAW_BYTES + 1).fill(0x78); // 'x' repeated
    expect(
      await errorCodeOf(() =>
        createFormalDeal(pool, ports, {
          actorPrincipalId: randomUUID(),
          correlationId: randomUUID(),
          dealType: 'GOODS',
          creatorRole: 'BUYER',
          counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: oversized,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('TERMS_PAYLOAD_TOO_LARGE');

    // One byte under the cap, the same invalid JSON now reaches the decoder and fails there.
    const underCap = new Uint8Array(MAX_RAW_BYTES).fill(0x78);
    expect(
      await errorCodeOf(() =>
        createFormalDeal(pool, ports, {
          actorPrincipalId: randomUUID(),
          correlationId: randomUUID(),
          dealType: 'GOODS',
          creatorRole: 'BUYER',
          counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: underCap,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('INVALID_TERMS_ENVELOPE');

    // The oversized attempt reserved no idempotency key (§22.2).
    const actorPrincipalId = randomUUID();
    const sharedKey = key();
    await errorCodeOf(() =>
      createFormalDeal(pool, ports, {
        actorPrincipalId,
        correlationId: randomUUID(),
        dealType: 'GOODS',
        creatorRole: 'BUYER',
        counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: oversized,
        idempotencyKey: sharedKey,
      }),
    );
    const claims = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
        WHERE "scope"=$1 AND "idempotencyKey"=$2`,
      [`PRINCIPAL:${actorPrincipalId}`, sharedKey],
    );
    expect(claims.rows[0]!.count).toBe(0);
  });

  it('spec001_contract_text_is_preserved_exactly', async () => {
    const authored = '  Ünicode  Ťitle  with   spacing  ';
    const born = await createFormalDeal(pool, ports, {
      actorPrincipalId: randomUUID(),
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'BUYER',
      counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: new TextEncoder().encode(
        JSON.stringify({ common: { title: authored }, typeTerms: {} }),
      ),
      idempotencyKey: key(),
    });
    const stored = await pool.query<{ bytes: Buffer }>(
      `SELECT "termsPayloadCanonicalBytes" AS bytes FROM "AgreementRevision" WHERE "dealId"=$1`,
      [born.dealId],
    );
    const decoded = new TextDecoder().decode(stored.rows[0]!.bytes);
    // The accepted persisted string is exactly the authored string: no trim, no normalization.
    expect(decoded).toContain(authored);
    expect(JSON.parse(decoded).common.title).toBe(authored);
  });

  it('spec001_all_write_commands_are_idempotent', async () => {
    // Table-driven across all seven keyed commands. ExpireInvitationIfDue is deliberately absent:
    // it is state-idempotent and takes no caller key (§22.1).
    type Case = {
      name: string;
      scope: string;
      run: (idempotencyKey: string) => Promise<unknown>;
      assertSingleEffect: (committed: Record<string, unknown>) => Promise<void>;
    };
    const cases: Case[] = [];

    // A temporary real-PostgreSQL gate keeps every fresh claimant inside its first INSERT long
    // enough for all sibling transactions to overlap before any winner can commit. This is not a
    // production hook and is removed before the test returns.
    await pool.query(
      'CREATE TABLE IF NOT EXISTS spec001_test_r4_idempotency_gate (idempotency_key text primary key)',
    );
    await pool.query('TRUNCATE spec001_test_r4_idempotency_gate');
    await pool.query(`CREATE OR REPLACE FUNCTION spec001_test_r4_idempotency_overlap()
        RETURNS TRIGGER LANGUAGE plpgsql AS $fn$ BEGIN
          IF EXISTS (SELECT 1 FROM spec001_test_r4_idempotency_gate g
                      WHERE g.idempotency_key = NEW."idempotencyKey") THEN
            PERFORM pg_sleep(0.35);
          END IF;
          RETURN NEW;
        END; $fn$;`);
    await pool.query(
      'DROP TRIGGER IF EXISTS "ApplicationIdempotencyRecord_r4_overlap" ON "ApplicationIdempotencyRecord"',
    );
    await pool.query(`CREATE TRIGGER "ApplicationIdempotencyRecord_r4_overlap"
        BEFORE INSERT ON "ApplicationIdempotencyRecord" FOR EACH ROW
        EXECUTE FUNCTION spec001_test_r4_idempotency_overlap()`);

    try {
      // The actor and target are fixed: the idempotency scope is PRINCIPAL:<actor>, so a fresh
      // actor per call would be a different semantic command rather than a retry.
      const createActor = randomUUID();
      const createCounterparty = randomUUID();
      cases.push({
        name: 'CreateFormalDeal',
        scope: `PRINCIPAL:${createActor}`,
        run: (idempotencyKey) =>
          createFormalDeal(pool, ports, {
            actorPrincipalId: createActor,
            correlationId: randomUUID(),
            dealType: 'GOODS',
            creatorRole: 'BUYER',
            counterpartyTarget: { kind: 'PRINCIPAL', principalId: createCounterparty },
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms: terms('Idempotent create probe'),
            idempotencyKey,
          }),
        assertSingleEffect: async (committed) => {
          const facts = await pool.query<{
            deals: number;
            slots: number;
            revisions: number;
            responses: number;
            events: number;
          }>(
            `SELECT
             (SELECT count(*)::int FROM "Deal" WHERE "id"=$1) AS deals,
             (SELECT count(*)::int FROM "DealPartySlot" WHERE "dealId"=$1) AS slots,
             (SELECT count(*)::int FROM "AgreementRevision" WHERE "dealId"=$1) AS revisions,
             (SELECT count(*)::int FROM "RevisionResponse" WHERE "dealId"=$1) AS responses,
             (SELECT count(*)::int FROM "DealAgreementAuditEvent" WHERE "dealId"=$1) AS events`,
            [committed.dealId],
          );
          expect(facts.rows[0]).toEqual({
            deals: 1,
            slots: 2,
            revisions: 1,
            responses: 1,
            events: 3,
          });
        },
      });

      const pendingInviteId = randomUUID();
      const pendingBorn = await createFormalDeal(pool, ports, {
        actorPrincipalId: randomUUID(),
        correlationId: randomUUID(),
        dealType: 'GOODS',
        creatorRole: 'BUYER',
        counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId },
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Idempotent bind'),
        idempotencyKey: key(),
      });
      const bindPrincipal = randomUUID();
      cases.push({
        name: 'BindCounterpartyPrincipal',
        scope: 'TRUSTED_IDENTITY:identity-service',
        run: (idempotencyKey) =>
          bindCounterpartyPrincipal(pool, ports, {
            trustedCaller: 'identity-service',
            correlationId: randomUUID(),
            dealId: pendingBorn.dealId,
            pendingInviteId,
            principalId: bindPrincipal,
            idempotencyKey,
          }),
        assertSingleEffect: async () => {
          const slot = await pool.query<{ principalId: string; boundAt: Date }>(
            `SELECT "principalId" AS "principalId","boundAt" AS "boundAt"
             FROM "DealPartySlot" WHERE "dealId"=$1 AND "slotKind"='COUNTERPARTY'`,
            [pendingBorn.dealId],
          );
          expect(slot.rows[0]!.principalId).toBe(bindPrincipal);
          expect(slot.rows[0]!.boundAt).toBeInstanceOf(Date);
          expect(
            (await auditEvents(pool, pendingBorn.dealId)).filter(
              (event) => event === 'COUNTERPARTY_BOUND',
            ),
          ).toHaveLength(1);
        },
      });

      const acceptDeal = await bornDeal(pool, { title: 'Idempotent accept' });
      cases.push({
        name: 'AcceptCurrentRevision',
        scope: `PRINCIPAL:${acceptDeal.counterpartyId}`,
        run: (idempotencyKey) =>
          acceptCurrentRevision(pool, ports, {
            actorPrincipalId: acceptDeal.counterpartyId,
            correlationId: randomUUID(),
            dealId: acceptDeal.dealId,
            targetRevisionId: acceptDeal.revisionId,
            idempotencyKey,
          }),
        assertSingleEffect: async () => {
          expect(
            (await responseRows(pool, acceptDeal.dealId)).filter(
              (response) => response.responseOrigin === 'EXPLICIT',
            ),
          ).toHaveLength(1);
          expect((await dealRow(pool, acceptDeal.dealId)).version).toBe(2);
          expect(
            (await auditEvents(pool, acceptDeal.dealId)).filter(
              (event) => event === 'MUTUAL_ACCEPTANCE_REACHED',
            ),
          ).toHaveLength(1);
        },
      });

      const rejectDeal = await bornDeal(pool, { title: 'Idempotent reject' });
      cases.push({
        name: 'RejectCurrentRevision',
        scope: `PRINCIPAL:${rejectDeal.counterpartyId}`,
        run: (idempotencyKey) =>
          rejectCurrentRevision(pool, ports, {
            actorPrincipalId: rejectDeal.counterpartyId,
            correlationId: randomUUID(),
            dealId: rejectDeal.dealId,
            targetRevisionId: rejectDeal.revisionId,
            idempotencyKey,
          }),
        assertSingleEffect: async () => {
          expect((await dealRow(pool, rejectDeal.dealId)).terminationReason).toBe('REJECTED');
          expect(
            (await responseRows(pool, rejectDeal.dealId)).filter(
              (response) => response.responseKind === 'REJECT',
            ),
          ).toHaveLength(1);
          expect(
            (await auditEvents(pool, rejectDeal.dealId)).filter(
              (event) => event === 'REVISION_REJECTED',
            ),
          ).toHaveLength(1);
        },
      });

      const proposeDeal = await bornDeal(pool, { title: 'Idempotent propose' });
      cases.push({
        name: 'ProposeChanges',
        scope: `PRINCIPAL:${proposeDeal.counterpartyId}`,
        run: (idempotencyKey) =>
          proposeChanges(pool, ports, {
            actorPrincipalId: proposeDeal.counterpartyId,
            correlationId: randomUUID(),
            dealId: proposeDeal.dealId,
            baseRevisionId: proposeDeal.revisionId,
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms: terms('Idempotent propose', { v: 2 }),
            idempotencyKey,
          }),
        assertSingleEffect: async (committed) => {
          expect(await revisionRows(pool, proposeDeal.dealId)).toHaveLength(2);
          expect((await dealRow(pool, proposeDeal.dealId)).currentRevisionId).toBe(
            committed.revisionId,
          );
          expect(
            (await auditEvents(pool, proposeDeal.dealId)).filter(
              (event) => event === 'CURRENT_REVISION_ADVANCED',
            ),
          ).toHaveLength(1);
        },
      });

      const withdrawDeal = await bornDeal(pool, { title: 'Idempotent withdraw' });
      cases.push({
        name: 'WithdrawInvitation',
        scope: `PRINCIPAL:${withdrawDeal.creatorId}`,
        run: (idempotencyKey) =>
          withdrawInvitation(pool, ports, {
            actorPrincipalId: withdrawDeal.creatorId,
            correlationId: randomUUID(),
            dealId: withdrawDeal.dealId,
            targetRevisionId: withdrawDeal.revisionId,
            idempotencyKey,
          }),
        assertSingleEffect: async () => {
          const row = await dealRow(pool, withdrawDeal.dealId);
          expect(row.terminationReason).toBe('INVITATION_WITHDRAWN');
          expect(row.version).toBe(2);
          expect(
            (await auditEvents(pool, withdrawDeal.dealId)).filter(
              (event) => event === 'INVITATION_WITHDRAWN',
            ),
          ).toHaveLength(1);
        },
      });

      const negotiationDeal = await bornDeal(pool, { title: 'Idempotent negotiation withdraw' });
      const negotiationSuccessor = await proposeChanges(pool, ports, {
        actorPrincipalId: negotiationDeal.counterpartyId,
        correlationId: randomUUID(),
        dealId: negotiationDeal.dealId,
        baseRevisionId: negotiationDeal.revisionId,
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Idempotent negotiation withdraw', { v: 2 }),
        idempotencyKey: key(),
      });
      cases.push({
        name: 'WithdrawNegotiation',
        scope: `PRINCIPAL:${negotiationDeal.counterpartyId}`,
        run: (idempotencyKey) =>
          withdrawNegotiation(pool, ports, {
            actorPrincipalId: negotiationDeal.counterpartyId,
            correlationId: randomUUID(),
            dealId: negotiationDeal.dealId,
            targetRevisionId: negotiationSuccessor.revisionId,
            idempotencyKey,
          }),
        assertSingleEffect: async () => {
          const row = await dealRow(pool, negotiationDeal.dealId);
          expect(row.terminationReason).toBe('NEGOTIATION_WITHDRAWN');
          expect(row.version).toBe(3);
          expect(
            (await auditEvents(pool, negotiationDeal.dealId)).filter(
              (event) => event === 'NEGOTIATION_WITHDRAWN',
            ),
          ).toHaveLength(1);
        },
      });

      expect(cases).toHaveLength(7);
      for (const testCase of cases) {
        const commandKey = key();
        const existingClaim = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
          WHERE "scope"=$1 AND "commandType"=$2 AND "idempotencyKey"=$3`,
          [testCase.scope, testCase.name, commandKey],
        );
        expect(existingClaim.rows[0]!.count, `${testCase.name} must start fresh`).toBe(0);
        await pool.query(
          'INSERT INTO spec001_test_r4_idempotency_gate (idempotency_key) VALUES ($1)',
          [commandKey],
        );

        // Every call below is a first-attempt call dispatched before an outcome exists. The DB gate
        // above ensures their real transactions overlap at the unique claim.
        const concurrent = await Promise.allSettled(
          Array.from({ length: 6 }, () => testCase.run(commandKey)),
        );
        await pool.query('DELETE FROM spec001_test_r4_idempotency_gate WHERE idempotency_key=$1', [
          commandKey,
        ]);

        const fulfilled = concurrent
          .filter(
            (outcome): outcome is PromiseFulfilledResult<unknown> => outcome.status === 'fulfilled',
          )
          .map((outcome) => outcome.value as Record<string, unknown>);
        expect(fulfilled.length, `${testCase.name} must have a committed winner`).toBeGreaterThan(
          0,
        );
        expect(
          fulfilled.filter((outcome) => outcome.replayed === false),
          `${testCase.name} one authoritative executor`,
        ).toHaveLength(1);
        for (const outcome of concurrent) {
          if (outcome.status === 'rejected') {
            expect(outcome.reason).toBeInstanceOf(Spec001Error);
            expect((outcome.reason as Spec001Error).code).not.toBe('IDEMPOTENCY_CONFLICT');
            expect(['DEAL_WRITE_RETRYABLE', 'IDEMPOTENT_REQUEST_IN_PROGRESS']).toContain(
              (outcome.reason as Spec001Error).code,
            );
          }
        }

        const first = fulfilled.find((outcome) => outcome.replayed === false)!;
        await testCase.assertSingleEffect(first);
        const claim = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
          WHERE "scope"=$1 AND "commandType"=$2 AND "idempotencyKey"=$3`,
          [testCase.scope, testCase.name, commandKey],
        );
        expect(claim.rows[0]!.count).toBe(1);

        // After convergence, the same key returns the exact immutable original commit-time facts.
        const replay = (await testCase.run(commandKey)) as Record<string, unknown>;
        expect(replay.replayed, `${testCase.name} converged replay`).toBe(true);
        for (const [field, value] of Object.entries(first)) {
          if (field === 'replayed') continue;
          expect(replay[field], `${testCase.name}.${field}`).toEqual(value);
        }
      }
    } finally {
      await pool
        .query(
          'DROP TRIGGER IF EXISTS "ApplicationIdempotencyRecord_r4_overlap" ON "ApplicationIdempotencyRecord"',
        )
        .catch(() => undefined);
      await pool
        .query('DROP FUNCTION IF EXISTS spec001_test_r4_idempotency_overlap()')
        .catch(() => undefined);
      await pool
        .query('DROP TABLE IF EXISTS spec001_test_r4_idempotency_gate')
        .catch(() => undefined);
    }
  });

  it('spec001_idempotency_key_payload_change_conflicts', async () => {
    const deal = await bornDeal(pool, { title: 'Key payload conflict' });
    const acceptKey = key();
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    // Same key, different semantic target -> conflict, never a silent second meaning.
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: uuidV7(),
          idempotencyKey: acceptKey,
        }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');

    // Changing only correlationId is NOT a semantic change and still replays (§22.1).
    const replay = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    expect(replay.replayed).toBe(true);
  });

  it('spec001_e19_response_loss_replay', async () => {
    // The command commits, but the caller never observes the response (simulated network loss).
    const deal = await bornDeal(pool, { title: 'Response loss' });
    const lostKey = key();
    const committed = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: lostKey,
    });
    const versionAfterCommit = (await dealRow(pool, deal.dealId)).version;

    // The client retries the same semantic command with the same key.
    const retried = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: lostKey,
    });
    expect(retried.replayed).toBe(true);
    expect(retried.dealVersion).toBe(committed.dealVersion);

    // No duplicate effect: one response row, one audit event, no extra version increment.
    expect(await responseRows(pool, deal.dealId)).toHaveLength(2);
    const events = await auditEvents(pool, deal.dealId);
    expect(events.filter((event) => event === 'REVISION_ACCEPTED_EXPLICIT')).toHaveLength(1);
    expect((await dealRow(pool, deal.dealId)).version).toBe(versionAfterCommit);
  });

  it('spec001_expiry_latch_replays_invitation_expired_consistently', async () => {
    const deal = await bornDeal(pool, { title: 'Expiry latch replay' });
    await backdateInvitation(pool, deal.dealId);
    const latchKey = key();

    // The keyed command that first observes expiry latches it and commits a deterministic
    // typed-error outcome.
    const first = await errorOf(() =>
      acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: latchKey,
      }),
    );
    expect(first?.code).toBe('INVITATION_EXPIRED');
    const afterLatch = await dealRow(pool, deal.dealId);
    expect(afterLatch.terminationReason).toBe('INVITATION_EXPIRED');
    expect(afterLatch.version).toBe(2);

    // Replaying the same key returns the SAME typed error and re-materializes nothing.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await errorOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: latchKey,
        }),
      );
      expect(replay?.code).toBe('INVITATION_EXPIRED');
      expect(replay?.details.terminationReason).toBe('INVITATION_EXPIRED');
    }
    const afterReplays = await dealRow(pool, deal.dealId);
    expect(afterReplays.version).toBe(2);
    expect(
      (await auditEvents(pool, deal.dealId)).filter((event) => event === 'INVITATION_EXPIRED'),
    ).toHaveLength(1);

    // The stored outcome is the typed error, and the retired name INVITE_EXPIRED is never used.
    const stored = await pool.query<{ outcomeKind: string; outcome: Record<string, unknown> }>(
      `SELECT "outcomeKind","outcome" FROM "ApplicationIdempotencyRecord" WHERE "idempotencyKey"=$1`,
      [latchKey],
    );
    expect(stored.rows[0]!.outcomeKind).toBe('TYPED_ERROR');
    expect(stored.rows[0]!.outcome.typedErrorCode).toBe('INVITATION_EXPIRED');
    expect(JSON.stringify(stored.rows[0]!.outcome)).not.toContain('INVITE_EXPIRED"');
  });

  it('spec001_terminal_error_payload_exposes_termination_reason', async () => {
    const expectations: Array<[() => Promise<unknown>, string]> = [];

    const rejected = await bornDeal(pool, { title: 'Terminal reject' });
    await rejectCurrentRevision(pool, ports, {
      actorPrincipalId: rejected.counterpartyId,
      correlationId: randomUUID(),
      dealId: rejected.dealId,
      targetRevisionId: rejected.revisionId,
      idempotencyKey: key(),
    });
    expectations.push([
      () =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: rejected.creatorId,
          correlationId: randomUUID(),
          dealId: rejected.dealId,
          targetRevisionId: rejected.revisionId,
          idempotencyKey: key(),
        }),
      'REJECTED',
    ]);

    const withdrawn = await bornDeal(pool, { title: 'Terminal withdraw' });
    await withdrawInvitation(pool, ports, {
      actorPrincipalId: withdrawn.creatorId,
      correlationId: randomUUID(),
      dealId: withdrawn.dealId,
      targetRevisionId: withdrawn.revisionId,
      idempotencyKey: key(),
    });
    expectations.push([
      () =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: withdrawn.counterpartyId,
          correlationId: randomUUID(),
          dealId: withdrawn.dealId,
          targetRevisionId: withdrawn.revisionId,
          idempotencyKey: key(),
        }),
      'INVITATION_WITHDRAWN',
    ]);

    const negotiation = await bornDeal(pool, { title: 'Terminal negotiation' });
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: negotiation.counterpartyId,
      correlationId: randomUUID(),
      dealId: negotiation.dealId,
      baseRevisionId: negotiation.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Terminal negotiation', { v: 2 }),
      idempotencyKey: key(),
    });
    await withdrawNegotiation(pool, ports, {
      actorPrincipalId: negotiation.counterpartyId,
      correlationId: randomUUID(),
      dealId: negotiation.dealId,
      targetRevisionId: successor.revisionId,
      idempotencyKey: key(),
    });
    expectations.push([
      () =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: negotiation.creatorId,
          correlationId: randomUUID(),
          dealId: negotiation.dealId,
          targetRevisionId: successor.revisionId,
          idempotencyKey: key(),
        }),
      'NEGOTIATION_WITHDRAWN',
    ]);

    const expired = await bornDeal(pool, { title: 'Terminal expiry' });
    await backdateInvitation(pool, expired.dealId);
    await errorOf(() =>
      acceptCurrentRevision(pool, ports, {
        actorPrincipalId: expired.counterpartyId,
        correlationId: randomUUID(),
        dealId: expired.dealId,
        targetRevisionId: expired.revisionId,
        idempotencyKey: key(),
      }),
    );
    expectations.push([
      () =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: expired.counterpartyId,
          correlationId: randomUUID(),
          dealId: expired.dealId,
          targetRevisionId: expired.revisionId,
          idempotencyKey: key(),
        }),
      'INVITATION_EXPIRED',
    ]);

    // All four terminal outcomes are distinguishable from the structured error payload alone.
    const seen = new Set<string>();
    for (const [attempt, reason] of expectations) {
      const failure = await errorOf(attempt);
      expect(failure?.code).toBe('DEAL_TERMINATED');
      expect(failure?.details.terminationReason).toBe(reason);
      seen.add(reason);
    }
    expect(seen.size).toBe(4);
  });

  it('spec001_stale_action_loses_with_typed_conflict', async () => {
    const deal = await bornDeal(pool, { title: 'Stale action' });
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Stale action', { v: 2 }),
      idempotencyKey: key(),
    });
    // Every stale-target command loses with a typed conflict and mutates nothing.
    const before = await dealRow(pool, deal.dealId);
    for (const attempt of [
      () =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      () =>
        rejectCurrentRevision(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      () =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Stale action', { v: 3 }),
          idempotencyKey: key(),
        }),
    ]) {
      const failure = await errorOf(attempt);
      expect(failure?.code).toBe('REVISION_NOT_CURRENT');
      expect(failure?.details.expectedRevisionId).toBe(successor.revisionId);
    }
    const after = await dealRow(pool, deal.dealId);
    expect(after.version).toBe(before.version);
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
  });

  it('spec001_current_revision_fk_is_nonnull_same_deal_and_deferred', async () => {
    // The constraint exists, is a composite same-Deal FK, and is DEFERRABLE INITIALLY DEFERRED.
    const constraint = await pool.query<{
      definition: string;
      deferrable: boolean;
      deferred: boolean;
    }>(
      `SELECT pg_get_constraintdef(oid) AS definition, condeferrable AS deferrable, condeferred AS deferred
         FROM pg_constraint WHERE conname='Deal_currentRevision_same_deal_fkey'`,
    );
    expect(constraint.rowCount).toBe(1);
    expect(constraint.rows[0]!.deferrable).toBe(true);
    expect(constraint.rows[0]!.deferred).toBe(true);
    expect(constraint.rows[0]!.definition).toContain('FOREIGN KEY (id, "currentRevisionId")');

    // currentRevisionId is NOT NULL at the column level.
    const nullability = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name='Deal' AND column_name='currentRevisionId'`,
    );
    expect(nullability.rows[0]!.is_nullable).toBe('NO');

    // Every committed Deal points at a revision of its own Deal.
    const anomalies = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "Deal" d
        WHERE NOT EXISTS (
          SELECT 1 FROM "AgreementRevision" r
           WHERE r."id" = d."currentRevisionId" AND r."dealId" = d."id")`,
    );
    expect(anomalies.rows[0]!.count).toBe(0);
  });

  it('spec001_command_time_is_single_db_value_after_lock', async () => {
    const deal = await bornDeal(pool, { title: 'Command time' });

    // Hold the Deal row lock, then start a command that must wait for it. If the command used
    // now()/transaction_timestamp() its time would be pinned at transaction start (before the
    // wait); clock_timestamp() read AFTER the lock must land after the lock was released.
    const blocker = await pool.connect();
    const holdMs = 900;
    // Held in an object so the initial value is genuinely read if the try block throws.
    const timing = { released: 0 };
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT * FROM "Deal" WHERE "id"=$1 FOR UPDATE', [deal.dealId]);
      const pending = acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: key(),
      });
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      timing.released = Date.now();
      await blocker.query('ROLLBACK');
      await pending;
    } finally {
      blocker.release();
    }

    const events = await pool.query<{ commandTime: Date; eventType: string }>(
      `SELECT "commandTime","eventType"::text AS "eventType" FROM "DealAgreementAuditEvent"
        WHERE "dealId"=$1 AND "eventType" IN ('REVISION_ACCEPTED_EXPLICIT','MUTUAL_ACCEPTANCE_REACHED')`,
      [deal.dealId],
    );
    expect(events.rowCount).toBe(2);
    const [firstEvent, secondEvent] = events.rows;
    // One single command time shared by every timestamp the command wrote.
    expect(firstEvent!.commandTime.getTime()).toBe(secondEvent!.commandTime.getTime());
    const row = await dealRow(pool, deal.dealId);
    expect(row.firstMutualAcceptedAt!.getTime()).toBe(firstEvent!.commandTime.getTime());
    const responses = await pool.query<{ createdAt: Date }>(
      `SELECT "createdAt" FROM "RevisionResponse" WHERE "dealId"=$1 AND "responseOrigin"='EXPLICIT'`,
      [deal.dealId],
    );
    expect(responses.rows[0]!.createdAt.getTime()).toBe(firstEvent!.commandTime.getTime());
    // And it was captured after the lock wait, not at transaction start.
    expect(firstEvent!.commandTime.getTime()).toBeGreaterThanOrEqual(timing.released - 50);
  });

  it('spec001_revision_integrity_failure_fails_closed', async () => {
    const deal = await bornDeal(pool, { title: 'Integrity failure' });
    const before = await dealRow(pool, deal.dealId);

    // Simulate hostile/corrupted stored bytes. The append-only guard must be lifted to create
    // this state at all, which is itself evidence that the kernel cannot produce it.
    await corruptRevisionBytes(
      pool,
      `UPDATE "AgreementRevision" SET "integrityFingerprint" = decode(repeat('00',32),'hex')
        WHERE "id"=$1`,
      [deal.revisionId],
    );

    // Every guarded command now fails closed and commits no requested mutation.
    for (const attempt of [
      () =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      () =>
        rejectCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      () =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Integrity failure', { v: 2 }),
          idempotencyKey: key(),
        }),
      () =>
        withdrawInvitation(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
    ]) {
      expect(await errorCodeOf(attempt)).toBe('REVISION_INTEGRITY_FAILURE');
    }

    const after = await dealRow(pool, deal.dealId);
    expect(after.version).toBe(before.version);
    expect(after.terminationReason).toBeNull();
    expect(await revisionRows(pool, deal.dealId)).toHaveLength(1);
    // Only the creator's auto-ACCEPT exists; no contractual mutation was recorded.
    expect(await responseRows(pool, deal.dealId)).toHaveLength(1);
  });

  it('spec001_audit_and_logs_contain_no_terms_or_pii', async () => {
    // Unique sentinel contractual/PII-shaped values. The PII values are exercised at an
    // invite-like top-level boundary that the closed terms envelope rejects; they are not placed
    // inside legitimate business terms, where ordinary text is intentionally contractual data.
    const titleSentinel = 'SENTINEL-TITLE-8f2b7c1e';
    const contractSentinel = 'SENTINEL-CONTRACT-DESCRIPTION-51c4';
    const piiSentinel = 'sentinel.person+9f31@example.invalid';
    const phoneSentinel = '+9647701234567';
    const usernameSentinel = 'invite_username_73ab';

    // Capture the real configured Pino destination from the actual Nest application path.
    const output = new PassThrough();
    let logs = '';
    output.on('data', (chunk) => {
      logs += String(chunk);
    });
    const app = await createApi(
      resolveRuntimeConfig({
        DHAMANI_RUNTIME_MODE: 'test',
        DATABASE_URL: runtimeConnectionString(),
        DHAMANI_PRIVATE_SENTINEL: 'spec001-log-config-sentinel',
        PORT: '3012',
      }),
      output,
    );
    await app.listen(0);
    try {
      const address = app.getHttpServer().address() as { port: number };
      await fetch(`http://127.0.0.1:${address.port}/health/live`);

      const pendingInviteId = randomUUID();
      const born = await createFormalDeal(pool, ports, {
        actorPrincipalId: randomUUID(),
        correlationId: randomUUID(),
        dealType: 'GOODS',
        creatorRole: 'BUYER',
        counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId },
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: new TextEncoder().encode(
          JSON.stringify({
            common: { title: titleSentinel, description: contractSentinel },
            typeTerms: { businessNote: 'ordinary inert data' },
          }),
        ),
        idempotencyKey: key(),
      });

      // Raw phone/email/username have no accepted invite boundary field in this kernel. A hostile
      // top-level smuggling attempt fails and reserves no idempotency record or Deal.
      const rejectedActor = randomUUID();
      const rejectedKey = key();
      expect(
        await errorCodeOf(() =>
          createFormalDeal(pool, ports, {
            actorPrincipalId: rejectedActor,
            correlationId: randomUUID(),
            dealType: 'GOODS',
            creatorRole: 'BUYER',
            counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId: randomUUID() },
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms: new TextEncoder().encode(
              JSON.stringify({
                common: { title: 'Invite boundary probe' },
                typeTerms: {},
                inviteEmail: piiSentinel,
                invitePhone: phoneSentinel,
                inviteUsername: usernameSentinel,
              }),
            ),
            idempotencyKey: rejectedKey,
          }),
        ),
      ).toBe('INVALID_TERMS_ENVELOPE');
      const rejectedClaim = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
          WHERE "scope"=$1 AND "idempotencyKey"=$2`,
        [`PRINCIPAL:${rejectedActor}`, rejectedKey],
      );
      expect(rejectedClaim.rows[0]!.count).toBe(0);

      const audit = await pool.query<{ row: string }>(
        `SELECT row_to_json(e)::text AS row FROM "DealAgreementAuditEvent" e WHERE "dealId"=$1`,
        [born.dealId],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
      for (const row of audit.rows) {
        expect(row.row).not.toContain(titleSentinel);
        expect(row.row).not.toContain(contractSentinel);
        expect(row.row).not.toContain(piiSentinel);
        expect(row.row).not.toContain(phoneSentinel);
        expect(row.row).not.toContain(usernameSentinel);
      }

      // The idempotency outcome likewise stores no terms content.
      const stored = await pool.query<{ outcome: string }>(
        `SELECT "outcome"::text AS outcome FROM "ApplicationIdempotencyRecord"
          WHERE "outcome"->>'dealId' = $1`,
        [born.dealId],
      );
      for (const row of stored.rows) {
        expect(row.outcome).not.toContain(titleSentinel);
        expect(row.outcome).not.toContain(contractSentinel);
      }

      // Contract terms themselves ARE persisted in the revision; invite-like PII sentinels are
      // absent from the canonical bytes and every other kernel row.
      const revision = await pool.query<{ text: string }>(
        `SELECT convert_from("termsPayloadCanonicalBytes",'UTF8') AS text
           FROM "AgreementRevision" WHERE "dealId"=$1`,
        [born.dealId],
      );
      expect(revision.rows[0]!.text).toContain(titleSentinel);
      expect(revision.rows[0]!.text).toContain(contractSentinel);
      for (const pii of [piiSentinel, phoneSentinel, usernameSentinel])
        expect(revision.rows[0]!.text).not.toContain(pii);

      const slots = await pool.query<{ row: string }>(
        `SELECT row_to_json(s)::text AS row FROM "DealPartySlot" s WHERE "dealId"=$1`,
        [born.dealId],
      );
      expect(slots.rows.some((row) => row.row.includes(pendingInviteId))).toBe(true);
      for (const row of slots.rows)
        for (const pii of [piiSentinel, phoneSentinel, usernameSentinel])
          expect(row.row).not.toContain(pii);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(logs).toContain('request completed');
      for (const sentinel of [
        titleSentinel,
        contractSentinel,
        piiSentinel,
        phoneSentinel,
        usernameSentinel,
      ])
        expect(logs).not.toContain(sentinel);
    } finally {
      await app.close();
    }
  });

  it('spec001_reads_require_authorized_actor_scope', async () => {
    const deal = await bornDeal(pool, { title: 'Authorized reads' });

    // A bound participant may read.
    const asParticipant = await readDeal(
      pool,
      ports,
      { kind: 'PARTICIPANT', principalId: deal.counterpartyId },
      deal.dealId,
    );
    expect(asParticipant.dealId).toBe(deal.dealId);
    expect(asParticipant.agreementReady).toBe(false);

    // An outsider Principal cannot read Deal resources at all.
    expect(
      await errorCodeOf(() =>
        readDeal(pool, ports, { kind: 'PARTICIPANT', principalId: randomUUID() }, deal.dealId),
      ),
    ).toBe('NOT_DEAL_PARTICIPANT');

    // Holding the public reference is never authorization on its own.
    expect(
      await errorCodeOf(() =>
        readDealByPublicReference(
          pool,
          ports,
          { kind: 'PARTICIPANT', principalId: randomUUID() },
          deal.publicReference,
        ),
      ),
    ).toBe('NOT_DEAL_PARTICIPANT');

    // A named trusted internal scope may read; an unnamed one may not.
    const trusted = await readDealByPublicReference(
      pool,
      ports,
      { kind: 'TRUSTED_SYSTEM', purpose: 'expiry-materializer' },
      deal.publicReference,
    );
    expect(trusted.dealId).toBe(deal.dealId);
    expect(
      await errorCodeOf(() =>
        readDeal(pool, ports, { kind: 'TRUSTED_SYSTEM', purpose: '' }, deal.dealId),
      ),
    ).toBe('VALIDATION_ERROR');
  });

  it('spec001_runtime_role_cannot_bypass_db_protections', async () => {
    // Executed as the actual constrained runtime credential, never as owner.
    const identity = await runtime.query<{ user: string; superuser: boolean }>(
      `SELECT current_user AS user,
              COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),true) AS superuser`,
    );
    expect(identity.rows[0]!.user).toBe('dhamani_runtime');
    expect(identity.rows[0]!.superuser).toBe(false);

    const attacks = [
      'UPDATE "AgreementRevision" SET "termsSchemaId"=\'x\'',
      'DELETE FROM "RevisionResponse"',
      'TRUNCATE TABLE "DealAgreementAuditEvent"',
      'ALTER TABLE "AgreementRevision" DISABLE TRIGGER ALL',
      'DROP TRIGGER "Deal_update_guard" ON "Deal"',
      'ALTER TABLE "Deal" DROP CONSTRAINT "Deal_currentRevision_same_deal_fkey"',
      "SET session_replication_role = 'replica'",
    ];
    for (const statement of attacks) {
      const client = await runtime.connect();
      try {
        await client.query(statement);
        throw new Error(`runtime role was allowed to: ${statement}`);
      } catch (error) {
        expect(String(error), statement).toMatch(/permission denied|must be owner/i);
      } finally {
        client.release();
      }
    }
  });

  it('spec001_e41_pending_bind_terminal_race', async () => {
    // Frozen E41 requires bind raced against expiry, reject AND withdraw. Each variant runs
    // repeatedly with genuinely overlapping commands, all through the real Deal row lock.
    const pendingDeal = async (title: string) => {
      const pendingInviteId = randomUUID();
      const creatorId = randomUUID();
      const born = await createFormalDeal(pool, ports, {
        actorPrincipalId: creatorId,
        correlationId: randomUUID(),
        dealType: 'GOODS',
        creatorRole: 'BUYER',
        counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId },
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms(title),
        idempotencyKey: key(),
      });
      return { born, creatorId, pendingInviteId };
    };

    const counterpartySlot = async (dealId: string) => {
      const slot = await pool.query<{ principalId: string | null; boundAt: Date | null }>(
        'SELECT "principalId","boundAt" FROM "DealPartySlot" WHERE "dealId"=$1 AND "slotKind"=$2',
        [dealId, 'COUNTERPARTY'],
      );
      return slot.rows[0]!;
    };

    /** Every committed combination must be internally consistent, whichever order won. */
    const assertLawful = async (dealId: string, winners: number) => {
      const row = await dealRow(pool, dealId);
      const slot = await counterpartySlot(dealId);
      const bound = slot.principalId !== null;
      // §23.4 — exactly one version increment per successful command, and no others.
      expect(row.version).toBe(1 + winners);
      // Never a half-bound slot.
      expect(slot.principalId === null).toBe(slot.boundAt === null);
      // §23.5 — an expired invite can never later bind.
      if (row.terminationReason === 'INVITATION_EXPIRED') expect(bound).toBe(false);
      const events = await auditEvents(pool, dealId);
      for (const terminal of ['INVITATION_EXPIRED', 'INVITATION_WITHDRAWN', 'REVISION_REJECTED'])
        expect(events.filter((event) => event === terminal).length).toBeLessThanOrEqual(1);
      return { row, bound };
    };

    // ---- variant 1: bind vs WITHDRAW ----
    for (let round = 0; round < 4; round += 1) {
      const { born, creatorId, pendingInviteId } = await pendingDeal(`Bind vs withdraw ${round}`);
      const results = await Promise.allSettled([
        bindCounterpartyPrincipal(pool, ports, {
          trustedCaller: 'identity-service',
          correlationId: randomUUID(),
          dealId: born.dealId,
          pendingInviteId,
          principalId: randomUUID(),
          idempotencyKey: key(),
        }),
        withdrawInvitation(pool, ports, {
          actorPrincipalId: creatorId,
          correlationId: randomUUID(),
          dealId: born.dealId,
          targetRevisionId: born.currentRevisionId,
          idempotencyKey: key(),
        }),
      ]);
      for (const outcome of results)
        if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(Spec001Error);
      const winners = results.filter((outcome) => outcome.status === 'fulfilled').length;
      const { row, bound } = await assertLawful(born.dealId, winners);
      if (row.terminationReason !== null && !bound)
        expect(row.terminationReason).toBe('INVITATION_WITHDRAWN');
    }

    // ---- variant 2: bind vs EXPIRY (§23.5 "expired invite cannot later bind") ----
    for (let round = 0; round < 4; round += 1) {
      const { born, pendingInviteId } = await pendingDeal(`Bind vs expiry ${round}`);
      await backdateInvitation(pool, born.dealId);
      const results = await Promise.allSettled([
        bindCounterpartyPrincipal(pool, ports, {
          trustedCaller: 'identity-service',
          correlationId: randomUUID(),
          dealId: born.dealId,
          pendingInviteId,
          principalId: randomUUID(),
          idempotencyKey: key(),
        }),
        expireInvitationIfDue(pool, ports, {
          actorScope: 'SYSTEM:expiry',
          correlationId: randomUUID(),
          dealId: born.dealId,
        }),
      ]);

      // The bind can never succeed against a due invitation; expiry is authoritative.
      const bindOutcome = results[0]!;
      expect(bindOutcome.status).toBe('rejected');
      const bindError = (bindOutcome as PromiseRejectedResult).reason as Spec001Error;
      expect(bindError).toBeInstanceOf(Spec001Error);
      expect(['INVITATION_EXPIRED', 'DEAL_TERMINATED', 'DEAL_WRITE_RETRYABLE']).toContain(
        bindError.code,
      );

      const row = await dealRow(pool, born.dealId);
      expect(row.terminationReason).toBe('INVITATION_EXPIRED');
      expect((await counterpartySlot(born.dealId)).principalId).toBeNull();
      // Exactly one expiry materialization however the race resolved.
      const events = await auditEvents(pool, born.dealId);
      expect(events.filter((event) => event === 'INVITATION_EXPIRED')).toHaveLength(1);
      expect(row.version).toBe(2);
    }

    // ---- variant 3: bind vs REJECT by the Principal being bound ----
    // Before binding, that Principal is an outsider and must fail safely; if the bind
    // serialises first the reject may legitimately become authorized. Either committed
    // combination must be lawful.
    for (let round = 0; round < 4; round += 1) {
      const { born, pendingInviteId } = await pendingDeal(`Bind vs reject ${round}`);
      const incoming = randomUUID();
      const results = await Promise.allSettled([
        bindCounterpartyPrincipal(pool, ports, {
          trustedCaller: 'identity-service',
          correlationId: randomUUID(),
          dealId: born.dealId,
          pendingInviteId,
          principalId: incoming,
          idempotencyKey: key(),
        }),
        rejectCurrentRevision(pool, ports, {
          actorPrincipalId: incoming,
          correlationId: randomUUID(),
          dealId: born.dealId,
          targetRevisionId: born.currentRevisionId,
          idempotencyKey: key(),
        }),
      ]);
      for (const outcome of results)
        if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(Spec001Error);
      const winners = results.filter((outcome) => outcome.status === 'fulfilled').length;
      const { row, bound } = await assertLawful(born.dealId, winners);

      const rejectOutcome = results[1]!;
      if (rejectOutcome.status === 'fulfilled') {
        // A reject can only have committed if the bind serialised first.
        expect(bound).toBe(true);
        expect(row.terminationReason).toBe('REJECTED');
        const responses = await responseRows(pool, born.dealId);
        expect(
          responses.filter(
            (response) => response.principalId === incoming && response.responseKind === 'REJECT',
          ),
        ).toHaveLength(1);
      } else {
        expect([
          'NOT_DEAL_PARTICIPANT',
          'DEAL_TERMINATED',
          'DEAL_WRITE_RETRYABLE',
          'IDEMPOTENT_REQUEST_IN_PROGRESS',
        ]).toContain((rejectOutcome.reason as Spec001Error).code);
        // No REJECT row may exist for a Principal that was never bound.
        if (!bound) {
          const responses = await responseRows(pool, born.dealId);
          expect(responses.filter((response) => response.principalId === incoming)).toHaveLength(0);
        }
      }
    }
  }, 300_000);

  it('spec001_concurrent_successor_race_has_one_winner', async () => {
    for (let round = 0; round < 4; round += 1) {
      const deal = await bornDeal(pool, { title: `Successor winner ${round}` });
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          proposeChanges(pool, ports, {
            actorPrincipalId: deal.counterpartyId,
            correlationId: randomUUID(),
            dealId: deal.dealId,
            baseRevisionId: deal.revisionId,
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms: terms(`Successor winner ${round}`, { branch: index }),
            idempotencyKey: key(),
          }),
        ),
      );
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const revisions = await revisionRows(pool, deal.dealId);
      expect(revisions).toHaveLength(2);
      expect(revisions[1]!.revisionNumber).toBe(2);
    }
  });
});
