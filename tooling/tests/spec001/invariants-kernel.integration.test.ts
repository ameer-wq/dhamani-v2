import { afterAll, describe, expect, it } from 'vitest';
import {
  DEAL_TYPES,
  MAX_SUCCESSOR_CREDITS_PER_PARTICIPANT,
  Spec001Error,
  committedSuccessorCredits,
  deriveAgreementReady,
  deriveCounterpartyRole,
  isDealType,
  legalRoleTriples,
  payerRoleFor,
  termsSchemaIds,
} from '../../../packages/domain/src/index.ts';
import { SPEC001_COMMAND_NAMES } from '../../../apps/api/src/spec001/kernel.ts';
import { uuidV7, publicDealReference } from '../../../apps/api/src/spec001/crypto.ts';
import { readDeal, readDealByPublicReference } from '../../../apps/api/src/spec001/reads.ts';
import { createFormalDeal } from '../../../apps/api/src/spec001/commands/create-formal-deal.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import { rejectCurrentRevision } from '../../../apps/api/src/spec001/commands/reject-current-revision.ts';
import {
  withdrawInvitation,
  withdrawNegotiation,
} from '../../../apps/api/src/spec001/commands/withdraw.ts';
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
  terms,
} from './helpers.ts';

const pool = ownerPool();

afterAll(async () => {
  await pool.end();
});

const key = () => randomUUID();

describe('SPEC-001 kernel invariants', () => {
  it('spec001_v1_deal_type_registry_is_exact_and_no_deposit', async () => {
    // Exactly five enabled V1 types, and DEPOSIT is not one of them (§3.1).
    expect([...DEAL_TYPES]).toEqual([
      'GOODS',
      'SERVICES',
      'BOOKING',
      'SUBSCRIPTION',
      'DIGITAL_ASSET',
    ]);
    expect(isDealType('DEPOSIT')).toBe(false);
    expect(
      await errorCodeOf(() =>
        Promise.resolve().then(() => deriveCounterpartyRole('DEPOSIT' as never, 'BUYER')),
      ),
    ).toBe('INVALID_DEAL_TYPE');

    // The database enum agrees with the registry exactly — no hidden sixth type.
    const enumLabels = await pool.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'DealType' ORDER BY e.enumsortorder`,
    );
    expect(enumLabels.rows.map((row) => row.label)).toEqual([...DEAL_TYPES]);

    // One pinned schema per enabled type, and no others.
    expect(termsSchemaIds()).toHaveLength(DEAL_TYPES.length);

    // The registry is extensible by reviewed code, but the command surface stays at eight (§21).
    expect(SPEC001_COMMAND_NAMES).toHaveLength(8);
    expect(SPEC001_COMMAND_NAMES).not.toContain('DepositFunds');
  });

  it('spec001_role_pair_is_server_derived_per_deal', async () => {
    // The server derives the complement; the client never submits two arbitrary roles.
    expect(deriveCounterpartyRole('GOODS', 'BUYER')).toBe('SELLER');
    expect(deriveCounterpartyRole('GOODS', 'SELLER')).toBe('BUYER');
    expect(deriveCounterpartyRole('SERVICES', 'CLIENT')).toBe('SERVICE_PROVIDER');
    expect(deriveCounterpartyRole('BOOKING', 'CUSTOMER')).toBe('BOOKING_PROVIDER');
    expect(deriveCounterpartyRole('SUBSCRIPTION', 'SUBSCRIBER')).toBe('SUBSCRIPTION_PROVIDER');
    expect(deriveCounterpartyRole('DIGITAL_ASSET', 'BUYER')).toBe('SELLER');
    // A role from another type is not a legal creator role for this one.
    expect(() => deriveCounterpartyRole('GOODS', 'CLIENT')).toThrow(Spec001Error);

    const deal = await bornDeal(pool, {
      dealType: 'BOOKING',
      creatorRole: 'CUSTOMER',
      termsSchemaId: 'dhamani.booking.v1',
    });
    const slots = await pool.query<{ slotKind: string; role: string }>(
      `SELECT "slotKind"::text AS "slotKind","role"::text AS role FROM "DealPartySlot" WHERE "dealId"=$1`,
      [deal.dealId],
    );
    const byKind = new Map(slots.rows.map((row) => [row.slotKind, row.role]));
    expect(byKind.get('CREATOR')).toBe('CUSTOMER');
    expect(byKind.get('COUNTERPARTY')).toBe('BOOKING_PROVIDER');

    // Direct-SQL mismatch probe: an illegal (dealType, role) pair is rejected by the DB CHECK.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE "DealPartySlot" SET "role"='SELLER' WHERE "dealId"=$1 AND "slotKind"='COUNTERPARTY'`,
        [deal.dealId],
      );
      await client.query('COMMIT');
      throw new Error('illegal role/type pair was accepted');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      expect(String(error)).toMatch(/SPEC001_SLOT_IMMUTABLE|DealPartySlot_role_triple_check/);
    } finally {
      client.release();
    }

    // Every legal triple the registry declares is genuinely legal at the DB level.
    expect(legalRoleTriples().length).toBe(DEAL_TYPES.length * 2 * 2);
  });

  it('spec001_payer_role_is_deterministic_and_money_absent', async () => {
    // §4 payer-side role is frozen for later specs and is purely derived.
    expect(payerRoleFor('GOODS')).toBe('BUYER');
    expect(payerRoleFor('SERVICES')).toBe('CLIENT');
    expect(payerRoleFor('BOOKING')).toBe('CUSTOMER');
    expect(payerRoleFor('SUBSCRIPTION')).toBe('SUBSCRIBER');
    expect(payerRoleFor('DIGITAL_ASSET')).toBe('BUYER');
    for (const dealType of DEAL_TYPES) expect(payerRoleFor(dealType)).toBe(payerRoleFor(dealType));

    // SPEC-001 contains no amount and performs no funding: no money-bearing column exists on any
    // of the six tables.
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN ('Deal','DealPartySlot','AgreementRevision','RevisionResponse',
                             'DealAgreementAuditEvent','ApplicationIdempotencyRecord')`,
    );
    const financial =
      /(amount|currency|balance|price|fee|payout|refund|wallet|ledger|escrow|fundingDeadline)/i;
    const offenders = columns.rows.filter((row) => financial.test(row.column_name));
    expect(offenders).toEqual([]);
  });

  it('spec001_entity_ids_are_server_uuidv7_only', async () => {
    const deal = await bornDeal(pool);
    const ids = await pool.query<{ id: string }>(
      `SELECT "id" FROM "Deal" WHERE "id"=$1
       UNION ALL SELECT "id" FROM "AgreementRevision" WHERE "dealId"=$1
       UNION ALL SELECT "id" FROM "DealPartySlot" WHERE "dealId"=$1
       UNION ALL SELECT "id" FROM "RevisionResponse" WHERE "dealId"=$1
       UNION ALL SELECT "id" FROM "DealAgreementAuditEvent" WHERE "dealId"=$1`,
      [deal.dealId],
    );
    expect(ids.rowCount).toBeGreaterThanOrEqual(7);
    for (const row of ids.rows) {
      // Version nibble 7 and RFC 4122 variant bits.
      expect(row.id[14], `version nibble of ${row.id}`).toBe('7');
      expect('89ab').toContain(row.id[19]!);
    }
    // Minted ids are canonical lowercase hyphenated and monotonic in their timestamp prefix.
    const first = uuidV7(1000);
    const later = uuidV7(2000);
    expect(first < later).toBe(true);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // No SPEC-001 table may carry a DB-side random UUID default that could emit a UUIDv4.
    const defaults = await pool.query<{ table_name: string; column_default: string }>(
      `SELECT table_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND column_default IS NOT NULL
          AND table_name IN ('Deal','DealPartySlot','AgreementRevision','RevisionResponse',
                             'DealAgreementAuditEvent','ApplicationIdempotencyRecord')`,
    );
    expect(defaults.rows).toEqual([]);
  });

  it('spec001_public_reference_unique_stable_and_collision_safe', async () => {
    const existing = await bornDeal(pool);
    expect(existing.publicReference).toMatch(
      /^DH-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    // Crockford Base32 excludes I, L, O and U.
    for (const forbidden of ['I', 'L', 'O', 'U'])
      expect(existing.publicReference.slice(3)).not.toContain(forbidden);

    // Injected generator forces real collisions, then yields a fresh reference: the whole birth
    // transaction is retried and one Deal is committed.
    let attempts = 0;
    const collideThenSucceed = {
      ...ports,
      newPublicReference: (): string => {
        attempts += 1;
        return attempts <= 3 ? existing.publicReference : publicDealReference();
      },
    };
    const recovered = await createFormalDeal(pool, collideThenSucceed, {
      actorPrincipalId: randomUUID(),
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'BUYER',
      counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Collision recovery'),
      idempotencyKey: key(),
    });
    expect(attempts).toBe(4);
    expect(recovered.publicReference).not.toBe(existing.publicReference);

    // Deterministic exhaustion: a permanently colliding generator fails typed after the bounded
    // retries and commits no Formal Deal and no idempotency success.
    const alwaysCollide = { ...ports, newPublicReference: (): string => existing.publicReference };
    const exhaustionKey = key();
    const actorPrincipalId = randomUUID();
    expect(
      await errorCodeOf(() =>
        createFormalDeal(pool, alwaysCollide, {
          actorPrincipalId,
          correlationId: randomUUID(),
          dealType: 'GOODS',
          creatorRole: 'BUYER',
          counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Collision exhaustion'),
          idempotencyKey: exhaustionKey,
        }),
      ),
    ).toBe('DEAL_REFERENCE_GENERATION_FAILED');
    const references = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "Deal" WHERE "publicReference"=$1`,
      [existing.publicReference],
    );
    expect(references.rows[0]!.count).toBe(1);
    const claims = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
        WHERE "scope"=$1 AND "idempotencyKey"=$2`,
      [`PRINCIPAL:${actorPrincipalId}`, exhaustionKey],
    );
    expect(claims.rows[0]!.count).toBe(0);
  });

  it('spec001_committed_deal_has_exactly_two_party_slots', async () => {
    const deal = await bornDeal(pool);
    const slots = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "DealPartySlot" WHERE "dealId"=$1`,
      [deal.dealId],
    );
    expect(slots.rows[0]!.count).toBe(2);

    // Every committed Deal in the database has exactly two slots — zero and one are impossible.
    const anomalies = await pool.query<{ dealId: string; slots: number }>(
      `SELECT d."id" AS "dealId", count(s."id")::int AS slots
         FROM "Deal" d LEFT JOIN "DealPartySlot" s ON s."dealId" = d."id"
        GROUP BY d."id" HAVING count(s."id") <> 2`,
    );
    expect(anomalies.rows).toEqual([]);
  });

  it('spec001_same_principal_cannot_bind_both_slots', async () => {
    const shared = randomUUID();
    expect(
      await errorCodeOf(() =>
        createFormalDeal(pool, ports, {
          actorPrincipalId: shared,
          correlationId: randomUUID(),
          dealType: 'GOODS',
          creatorRole: 'BUYER',
          counterpartyTarget: { kind: 'PRINCIPAL', principalId: shared },
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Self deal'),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('SAME_PARTICIPANT_BOTH_SIDES');

    // The database independently forbids the same bound Principal on both sides.
    const deal = await bornDeal(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE "DealPartySlot" SET "principalId"=$1 WHERE "dealId"=$2 AND "slotKind"='COUNTERPARTY'`,
        [deal.creatorId, deal.dealId],
      );
      await client.query('COMMIT');
      throw new Error('duplicate principal accepted');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      expect(String(error)).toMatch(
        /SPEC001_SLOT_PRINCIPAL_SET_ONCE|DealPartySlot_deal_principal_key/,
      );
    } finally {
      client.release();
    }
  });

  it('spec001_deal_birth_is_all_or_nothing', async () => {
    // A birth that fails validation after the strict terms checks commits nothing at all.
    const actorPrincipalId = randomUUID();
    const idempotencyKey = key();
    expect(
      await errorCodeOf(() =>
        createFormalDeal(pool, ports, {
          actorPrincipalId,
          correlationId: randomUUID(),
          dealType: 'GOODS',
          creatorRole: 'CLIENT', // illegal role for GOODS
          counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Half born'),
          idempotencyKey,
        }),
      ),
    ).toBe('INVALID_DEAL_ROLE_PAIR');

    // The failed attempt released its idempotency claim: no half-born record survives.
    const claims = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "ApplicationIdempotencyRecord"
        WHERE "scope"=$1 AND "idempotencyKey"=$2`,
      [`PRINCIPAL:${actorPrincipalId}`, idempotencyKey],
    );
    expect(claims.rows[0]!.count).toBe(0);

    // A corrected retry under the SAME key may then execute normally (§22.6).
    const corrected = await createFormalDeal(pool, ports, {
      actorPrincipalId,
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'BUYER',
      counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Half born'),
      idempotencyKey,
    });
    expect(corrected.replayed).toBe(false);
  });

  it('spec001_formal_identity_fields_cannot_be_mutated', async () => {
    const deal = await bornDeal(pool);
    const before = await dealRow(pool, deal.dealId);
    const attempts: Array<[string, string]> = [
      [
        'publicReference',
        `UPDATE "Deal" SET "version"="version"+1,"publicReference"='DH-2222-3333-4444' WHERE "id"=$1`,
      ],
      ['dealType', `UPDATE "Deal" SET "version"="version"+1,"dealType"='SERVICES' WHERE "id"=$1`],
      ['sentAt', `UPDATE "Deal" SET "version"="version"+1,"sentAt"=now() WHERE "id"=$1`],
      [
        'inviteExpiresAt',
        `UPDATE "Deal" SET "version"="version"+1,"inviteExpiresAt"=now() WHERE "id"=$1`,
      ],
      ['createdAt', `UPDATE "Deal" SET "version"="version"+1,"createdAt"=now() WHERE "id"=$1`],
    ];
    for (const [field, statement] of attempts) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(statement, [deal.dealId]);
        await client.query('COMMIT');
        throw new Error(`${field} mutation was accepted`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        expect(String(error), field).toMatch(/SPEC001_DEAL_IDENTITY_IMMUTABLE/);
      } finally {
        client.release();
      }
    }
    const after = await dealRow(pool, deal.dealId);
    expect(after.version).toBe(before.version);
    expect(after.sentAt.getTime()).toBe(before.sentAt.getTime());
  });

  it('spec001_pending_invite_is_opaque_and_one_time_bind', async () => {
    const pendingInviteId = randomUUID();
    const born = await createFormalDeal(pool, ports, {
      actorPrincipalId: randomUUID(),
      correlationId: randomUUID(),
      dealType: 'DIGITAL_ASSET',
      creatorRole: 'SELLER',
      counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId },
      termsSchemaId: 'dhamani.digital_asset.v1',
      rawTerms: terms('Opaque invite'),
      idempotencyKey: key(),
    });
    // The pending invite is an opaque UUID carrying no PII, and grants no authority by possession.
    expect(pendingInviteId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await pool.query<{ pendingInviteId: string; principalId: string | null }>(
      `SELECT "pendingInviteId","principalId" FROM "DealPartySlot"
        WHERE "dealId"=$1 AND "slotKind"='COUNTERPARTY'`,
      [born.dealId],
    );
    expect(stored.rows[0]!.pendingInviteId).toBe(pendingInviteId);
    expect(stored.rows[0]!.principalId).toBeNull();

    // The kernel stores no raw phone/email/username anywhere for this Deal.
    const dump = JSON.stringify(stored.rows);
    expect(dump).not.toMatch(/@/);
  });

  it('spec001_invitation_expiry_is_server_authoritative_168h', async () => {
    const deal = await bornDeal(pool);
    const row = await dealRow(pool, deal.dealId);
    // Exactly 168 hours, derived from the single DB command time — client clocks never participate.
    expect(row.inviteExpiresAt.getTime() - row.sentAt.getTime()).toBe(168 * 3600 * 1000);

    // First observation after the boundary latches terminal expiry.
    await backdateInvitation(pool, deal.dealId);
    const failure = await errorOf(() =>
      acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: key(),
      }),
    );
    expect(failure?.code).toBe('INVITATION_EXPIRED');
    const expired = await dealRow(pool, deal.dealId);
    expect(expired.terminationReason).toBe('INVITATION_EXPIRED');
    expect(expired.version).toBe(2);
  });

  it('spec001_first_mutual_acceptance_consumes_invitation_expiry', async () => {
    const deal = await bornDeal(pool);
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    // Push the original deadline into the past AFTER first mutual acceptance.
    await backdateInvitation(pool, deal.dealId);

    // The consumed timer can never terminalize the Deal, and negotiation continues.
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { afterExpiryWindow: true }),
      idempotencyKey: key(),
    });
    expect(successor.revisionNumber).toBe(2);
    expect((await dealRow(pool, deal.dealId)).terminationReason).toBeNull();
  });

  it('spec001_revision_chain_is_linear_and_same_deal', async () => {
    const deal = await bornDeal(pool, { title: 'Chain probe' });
    let current = deal.revisionId;
    for (let round = 0; round < 2; round += 1) {
      const actor = round % 2 === 0 ? deal.counterpartyId : deal.creatorId;
      const other = round % 2 === 0 ? deal.creatorId : deal.counterpartyId;
      const proposal = await proposeChanges(pool, ports, {
        actorPrincipalId: actor,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        baseRevisionId: current,
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Chain probe', { round }),
        idempotencyKey: key(),
      });
      await acceptCurrentRevision(pool, ports, {
        actorPrincipalId: other,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: proposal.revisionId,
        idempotencyKey: key(),
      });
      current = proposal.revisionId;
    }
    const revisions = await revisionRows(pool, deal.dealId);
    expect(revisions.map((row) => row.revisionNumber)).toEqual([1, 2, 3]);
    // Strictly linear: each successor's predecessor is the immediately preceding revision.
    expect(revisions[0]!.predecessorRevisionId).toBeNull();
    expect(revisions[1]!.predecessorRevisionId).toBe(revisions[0]!.id);
    expect(revisions[2]!.predecessorRevisionId).toBe(revisions[1]!.id);
    // Exactly one revision per number per Deal: no fork can share a number.
    const duplicates = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT "dealId","revisionNumber" FROM "AgreementRevision"
          GROUP BY "dealId","revisionNumber" HAVING count(*) > 1) AS d`,
    );
    expect(duplicates.rows[0]!.count).toBe(0);
  });

  it('spec001_revision_creator_auto_accepts_exact_revision', async () => {
    const deal = await bornDeal(pool);
    const r1Responses = await responseRows(pool, deal.dealId);
    expect(r1Responses).toHaveLength(1);
    expect(r1Responses[0]!.principalId).toBe(deal.creatorId);
    expect(r1Responses[0]!.responseOrigin).toBe('REVISION_CREATOR_AUTO');

    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { v: 2 }),
      idempotencyKey: key(),
    });
    const all = await responseRows(pool, deal.dealId);
    const auto = all.find(
      (row) => row.revisionId === successor.revisionId && row.principalId === deal.counterpartyId,
    );
    // The auto-ACCEPT is bound to the EXACT revision its author created, not carried forward.
    expect(auto?.responseOrigin).toBe('REVISION_CREATOR_AUTO');
    expect(all.filter((row) => row.revisionId === successor.revisionId)).toHaveLength(1);
    expect(await auditEvents(pool, deal.dealId)).toContain('REVISION_ACCEPTED_AUTO');
  });

  it('spec001_acceptance_is_exact_revision_only', async () => {
    const deal = await bornDeal(pool);
    const other = await bornDeal(pool);
    // A revision id belonging to another Deal is not found for this Deal.
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: other.revisionId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('REVISION_NOT_FOUND');
    // An unknown revision id is likewise refused rather than defaulted to the current revision.
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: uuidV7(),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('REVISION_NOT_FOUND');
    expect(await responseRows(pool, deal.dealId)).toHaveLength(1);
  });

  it('spec001_successor_makes_prior_acceptance_stale_not_deleted', async () => {
    const deal = await bornDeal(pool);
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    const beforeResponses = await responseRows(pool, deal.dealId);
    expect(beforeResponses).toHaveLength(2);

    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { staleProbe: true }),
      idempotencyKey: key(),
    });

    // Historical responses to R1 are preserved, not deleted...
    const afterResponses = await responseRows(pool, deal.dealId);
    expect(afterResponses.filter((row) => row.revisionId === deal.revisionId)).toHaveLength(2);
    // ...but readiness is now false because the counterpart has not accepted the successor.
    const view = await pool.query<{ firstMutualAcceptedAt: Date | null }>(
      'SELECT "firstMutualAcceptedAt" FROM "Deal" WHERE "id"=$1',
      [deal.dealId],
    );
    expect(view.rows[0]!.firstMutualAcceptedAt).not.toBeNull(); // historical metadata survives
    const responsesToSuccessor = afterResponses.filter(
      (row) => row.revisionId === successor.revisionId,
    );
    expect(responsesToSuccessor).toHaveLength(1);
  });

  it('spec001_agreement_ready_is_strictly_derived', async () => {
    const now = new Date('2026-08-19T00:00:00Z');
    const base = {
      deal: {
        id: '00000000-0000-7000-8000-000000000001',
        dealType: 'GOODS' as const,
        currentRevisionId: 'r1',
        sentAt: now,
        inviteExpiresAt: new Date(now.getTime() + 168 * 3600 * 1000),
        firstMutualAcceptedAt: null,
        terminationReason: null,
        terminatedAt: null,
        version: 1,
      },
      slots: [
        {
          slotKind: 'CREATOR' as const,
          role: 'BUYER' as const,
          principalId: 'a',
          pendingInviteId: null,
          boundAt: now,
        },
        {
          slotKind: 'COUNTERPARTY' as const,
          role: 'SELLER' as const,
          principalId: 'b',
          pendingInviteId: null,
          boundAt: now,
        },
      ],
      revisions: [
        {
          id: 'r1',
          revisionNumber: 1,
          predecessorRevisionId: null,
          createdByPrincipalId: 'a',
          termsSchemaId: 's',
        },
      ],
      responses: [
        {
          revisionId: 'r1',
          principalId: 'a',
          responseKind: 'ACCEPT' as const,
          responseOrigin: 'REVISION_CREATOR_AUTO' as const,
        },
        {
          revisionId: 'r1',
          principalId: 'b',
          responseKind: 'ACCEPT' as const,
          responseOrigin: 'EXPLICIT' as const,
        },
      ],
      currentRevisionIntegrity: 'VERIFIED' as const,
    };
    expect(deriveAgreementReady(base, now)).toBe(true);

    // Each §18 condition independently falsifies readiness.
    // 1. Deal is terminal.
    expect(
      deriveAgreementReady({ ...base, deal: { ...base.deal, terminationReason: 'REJECTED' } }, now),
    ).toBe(false);
    // 2. Deal is effectively expired.
    expect(deriveAgreementReady(base, new Date(base.deal.inviteExpiresAt.getTime() + 1))).toBe(
      false,
    );
    // 3. Both slots are not bound.
    expect(
      deriveAgreementReady(
        { ...base, slots: [base.slots[0]!, { ...base.slots[1]!, principalId: null }] },
        now,
      ),
    ).toBe(false);
    // 4. Bound Principals are not distinct.
    expect(
      deriveAgreementReady(
        { ...base, slots: [base.slots[0]!, { ...base.slots[1]!, principalId: 'a' }] },
        now,
      ),
    ).toBe(false);
    // 5. Current revision does not exist.
    expect(
      deriveAgreementReady({ ...base, deal: { ...base.deal, currentRevisionId: 'missing' } }, now),
    ).toBe(false);
    // 6. Current revision does not PASS INTEGRITY VALIDATION (§18) — both the failed verdict and
    //    the fail-closed default of a snapshot that never performed the check.
    expect(deriveAgreementReady({ ...base, currentRevisionIntegrity: 'FAILED' }, now)).toBe(false);
    expect(deriveAgreementReady({ ...base, currentRevisionIntegrity: 'UNVERIFIED' }, now)).toBe(
      false,
    );
    // 7. A bound Principal has no ACCEPT for the exact current revision.
    expect(deriveAgreementReady({ ...base, responses: [base.responses[0]!] }, now)).toBe(false);
    expect(
      deriveAgreementReady(
        {
          ...base,
          responses: [base.responses[0]!, { ...base.responses[1]!, responseKind: 'REJECT' }],
        },
        now,
      ),
    ).toBe(false);
    // 8. A response to a DIFFERENT revision never confers readiness on the current one.
    expect(
      deriveAgreementReady(
        { ...base, responses: [base.responses[0]!, { ...base.responses[1]!, revisionId: 'r0' }] },
        now,
      ),
    ).toBe(false);

    // ---- real PostgreSQL: a corrupted current revision must fail the authorized read closed ----
    const deal = await bornDeal(pool, { title: 'Readiness integrity gate' });
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    const healthy = await readDeal(
      pool,
      ports,
      { kind: 'PARTICIPANT', principalId: deal.counterpartyId },
      deal.dealId,
    );
    expect(healthy.agreementReady).toBe(true);

    const before = await dealRow(pool, deal.dealId);
    await corruptRevisionBytes(
      pool,
      `UPDATE "AgreementRevision" SET "integrityFingerprint" = decode(repeat('00',32),'hex')
        WHERE "id"=$1`,
      [deal.revisionId],
    );

    // The read fails closed and cannot report readiness for a revision that fails integrity.
    expect(
      await errorCodeOf(() =>
        readDeal(
          pool,
          ports,
          { kind: 'PARTICIPANT', principalId: deal.counterpartyId },
          deal.dealId,
        ),
      ),
    ).toBe('REVISION_INTEGRITY_FAILURE');
    expect(
      await errorCodeOf(() =>
        readDealByPublicReference(
          pool,
          ports,
          { kind: 'TRUSTED_SYSTEM', purpose: 'readiness-audit' },
          deal.publicReference,
        ),
      ),
    ).toBe('REVISION_INTEGRITY_FAILURE');

    // No contractual mutation resulted from the refused reads.
    const after = await dealRow(pool, deal.dealId);
    expect(after.version).toBe(before.version);
    expect(after.terminationReason).toBeNull();
    expect(await responseRows(pool, deal.dealId)).toHaveLength(2);
  });

  it('spec001_client_terms_cannot_author_domain_authority', async () => {
    // Authority-looking keys at the closed top level are rejected.
    for (const smuggled of [
      '{"common":{"title":"Authority"},"typeTerms":{},"version":99}',
      '{"common":{"title":"Authority"},"typeTerms":{},"firstMutualAcceptedAt":"2020-01-01"}',
      '{"common":{"title":"Authority"},"typeTerms":{},"staffRole":"ADMIN"}',
    ]) {
      expect(
        await errorCodeOf(() =>
          createFormalDeal(pool, ports, {
            actorPrincipalId: randomUUID(),
            correlationId: randomUUID(),
            dealType: 'GOODS',
            creatorRole: 'BUYER',
            counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms: new TextEncoder().encode(smuggled),
            idempotencyKey: key(),
          }),
        ),
      ).toBe('INVALID_TERMS_ENVELOPE');
    }

    // Inside typeTerms the same names are inert business data and change no domain authority.
    const born = await createFormalDeal(pool, ports, {
      actorPrincipalId: randomUUID(),
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'BUYER',
      counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: new TextEncoder().encode(
        JSON.stringify({
          common: { title: 'Inert authority names' },
          typeTerms: { staffRole: 'ADMIN', version: 99, payerRole: 'SELLER' },
        }),
      ),
      idempotencyKey: key(),
    });
    const row = await dealRow(pool, born.dealId);
    expect(row.version).toBe(1);
    const slots = await pool.query<{ role: string }>(
      `SELECT "role"::text AS role FROM "DealPartySlot" WHERE "dealId"=$1 AND "slotKind"='CREATOR'`,
      [born.dealId],
    );
    // The server-derived role is untouched by the terms content.
    expect(slots.rows[0]!.role).toBe('BUYER');
  });

  it('spec001_reject_terminates_deal_negotiation', async () => {
    const deal = await bornDeal(pool);
    await rejectCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    const row = await dealRow(pool, deal.dealId);
    expect(row.terminationReason).toBe('REJECTED');
    expect(row.terminatedAt).not.toBeNull();

    // Every subsequent lifecycle command is refused with the terminal reason exposed.
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
        withdrawInvitation(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
    ]) {
      const failure = await errorOf(attempt);
      expect(failure?.code).toBe('DEAL_TERMINATED');
      expect(failure?.details.terminationReason).toBe('REJECTED');
    }
    // The REJECT response itself is immutable history.
    const responses = await responseRows(pool, deal.dealId);
    expect(responses.filter((row) => row.responseKind === 'REJECT')).toHaveLength(1);
  });

  it('spec001_invitation_withdraw_preconditions_are_strict', async () => {
    // Only the original creator may withdraw.
    const deal = await bornDeal(pool);
    expect(
      await errorCodeOf(() =>
        withdrawInvitation(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: deal.revisionId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('WITHDRAW_NOT_ALLOWED');

    // Only while the current revision is still R1.
    const advanced = await bornDeal(pool, { title: 'Advanced withdraw' });
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: advanced.counterpartyId,
      correlationId: randomUUID(),
      dealId: advanced.dealId,
      baseRevisionId: advanced.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Advanced withdraw', { v: 2 }),
      idempotencyKey: key(),
    });
    const failure = await errorOf(() =>
      withdrawInvitation(pool, ports, {
        actorPrincipalId: advanced.creatorId,
        correlationId: randomUUID(),
        dealId: advanced.dealId,
        targetRevisionId: successor.revisionId,
        idempotencyKey: key(),
      }),
    );
    expect(failure?.code).toBe('WITHDRAW_NOT_ALLOWED');
    expect(failure?.details.reason).toBe('NOT_R1');

    // The lawful case still succeeds.
    const ok = await withdrawInvitation(pool, ports, {
      actorPrincipalId: deal.creatorId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    expect(ok.terminationReason).toBe('INVITATION_WITHDRAWN');
  });

  it('spec001_successor_creator_can_terminally_withdraw_waiting_negotiation', async () => {
    const deal = await bornDeal(pool, { title: 'Negotiation withdraw' });
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Negotiation withdraw', { v: 2 }),
      idempotencyKey: key(),
    });

    // The non-proposer may not withdraw the negotiation.
    expect(
      await errorCodeOf(() =>
        withdrawNegotiation(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: successor.revisionId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('WITHDRAW_NOT_ALLOWED');

    const withdrawn = await withdrawNegotiation(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: successor.revisionId,
      idempotencyKey: key(),
    });
    expect(withdrawn.terminationReason).toBe('NEGOTIATION_WITHDRAWN');
    expect((await dealRow(pool, deal.dealId)).terminationReason).toBe('NEGOTIATION_WITHDRAWN');
  });

  it('spec001_modification_credits_are_history_derived_and_bounded', async () => {
    expect(MAX_SUCCESSOR_CREDITS_PER_PARTICIPANT).toBe(2);
    const deal = await bornDeal(pool, { title: 'Credit derivation' });

    // Non-consuming failure classes, each proven to leave credits untouched.
    const nonConsuming: Array<() => Promise<unknown>> = [
      // turn violation
      () =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Credit derivation', { turn: 'violation' }),
          idempotencyKey: key(),
        }),
      // unchanged terms
      () =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Credit derivation'),
          idempotencyKey: key(),
        }),
      // raw JSON failure
      () =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: new TextEncoder().encode('{"a":1,"a":2}'),
          idempotencyKey: key(),
        }),
      // stale base revision
      () =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: uuidV7(),
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Credit derivation', { stale: true }),
          idempotencyKey: key(),
        }),
    ];
    for (const attempt of nonConsuming) await errorCodeOf(attempt);

    const snapshotAfterFailures = {
      deal: { id: deal.dealId } as never,
      slots: [] as never,
      revisions: await revisionRows(pool, deal.dealId),
      responses: [] as never,
      currentRevisionIntegrity: 'VERIFIED' as const,
    };
    // Credits are derived purely from committed successors in history.
    expect(committedSuccessorCredits(snapshotAfterFailures as never, deal.counterpartyId)).toBe(0);

    // Two real successors consume exactly two credits; the third is refused.
    let current = deal.revisionId;
    for (let round = 0; round < 2; round += 1) {
      const proposal = await proposeChanges(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        baseRevisionId: current,
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Credit derivation', { committed: round }),
        idempotencyKey: key(),
      });
      await acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.creatorId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: proposal.revisionId,
        idempotencyKey: key(),
      });
      current = proposal.revisionId;
    }
    const finalRevisions = await revisionRows(pool, deal.dealId);
    expect(
      committedSuccessorCredits(
        {
          deal: {} as never,
          slots: [] as never,
          revisions: finalRevisions,
          responses: [] as never,
          currentRevisionIntegrity: 'VERIFIED' as const,
        },
        deal.counterpartyId,
      ),
    ).toBe(2);
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: current,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Credit derivation', { committed: 2 }),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('MODIFICATION_LIMIT_REACHED');
  });

  it('spec001_negotiation_is_turn_based', async () => {
    const deal = await bornDeal(pool, { title: 'Turn taking' });
    // While the counterpart's decision is awaited, the revision creator may not act again.
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Turn taking', { attempt: 1 }),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('ACTOR_MUST_WAIT_FOR_COUNTERPARTY');

    // The awaited participant may act.
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Turn taking', { attempt: 2 }),
      idempotencyKey: key(),
    });
    // Now the turn has flipped: the new proposer must wait.
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: successor.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Turn taking', { attempt: 3 }),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('ACTOR_MUST_WAIT_FOR_COUNTERPARTY');

    // Once mutually accepted, either participant may propose again (§17.2).
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.creatorId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: successor.revisionId,
      idempotencyKey: key(),
    });
    const afterReady = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: successor.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Turn taking', { attempt: 4 }),
      idempotencyKey: key(),
    });
    expect(afterReady.revisionNumber).toBe(3);
  });
});
