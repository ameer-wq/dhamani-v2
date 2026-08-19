import { afterAll, describe, expect, it } from 'vitest';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { bindCounterpartyPrincipal } from '../../../apps/api/src/spec001/commands/bind-counterparty-principal.ts';
import { createFormalDeal } from '../../../apps/api/src/spec001/commands/create-formal-deal.ts';
import { expireInvitationIfDue } from '../../../apps/api/src/spec001/commands/expire-invitation-if-due.ts';
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
  dealRow,
  errorCodeOf,
  errorOf,
  mutuallyAcceptedDeal,
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

describe('SPEC-001 negotiation lifecycle against real PostgreSQL', () => {
  it('spec001_e06_one_time_binding', async () => {
    const creatorId = randomUUID();
    const pendingInviteId = randomUUID();
    const born = await createFormalDeal(pool, ports, {
      actorPrincipalId: creatorId,
      correlationId: randomUUID(),
      dealType: 'SERVICES',
      creatorRole: 'CLIENT',
      counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId },
      termsSchemaId: 'dhamani.services.v1',
      rawTerms: terms('Website build'),
      idempotencyKey: key(),
    });
    const principalId = randomUUID();
    const bindKey = key();
    const first = await bindCounterpartyPrincipal(pool, ports, {
      trustedCaller: 'identity-service',
      correlationId: randomUUID(),
      dealId: born.dealId,
      pendingInviteId,
      principalId,
      idempotencyKey: bindKey,
    });
    expect(first.replayed).toBe(false);

    // Identical replay returns the same committed result and creates no second transition.
    const replay = await bindCounterpartyPrincipal(pool, ports, {
      trustedCaller: 'identity-service',
      correlationId: randomUUID(),
      dealId: born.dealId,
      pendingInviteId,
      principalId,
      idempotencyKey: bindKey,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.dealVersion).toBe(first.dealVersion);

    // A different later Principal is rejected: a bound slot is never rebound.
    expect(
      await errorCodeOf(() =>
        bindCounterpartyPrincipal(pool, ports, {
          trustedCaller: 'identity-service',
          correlationId: randomUUID(),
          dealId: born.dealId,
          pendingInviteId,
          principalId: randomUUID(),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('COUNTERPARTY_ALREADY_BOUND');

    // pendingInviteId is preserved as immutable provenance rather than cleared.
    const slot = await pool.query(
      `SELECT "principalId","pendingInviteId","boundAt" FROM "DealPartySlot"
        WHERE "dealId"=$1 AND "slotKind"='COUNTERPARTY'`,
      [born.dealId],
    );
    expect(slot.rows[0]!.principalId).toBe(principalId);
    expect(slot.rows[0]!.pendingInviteId).toBe(pendingInviteId);
    expect(slot.rows[0]!.boundAt).not.toBeNull();
    expect(await auditEvents(pool, born.dealId)).toContain('COUNTERPARTY_BOUND');
  });

  it('spec001_e07_bind_after_expiry', async () => {
    const creatorId = randomUUID();
    const pendingInviteId = randomUUID();
    const born = await createFormalDeal(pool, ports, {
      actorPrincipalId: creatorId,
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'SELLER',
      counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Camera sale'),
      idempotencyKey: key(),
    });
    await backdateInvitation(pool, born.dealId);

    const failure = await errorOf(() =>
      bindCounterpartyPrincipal(pool, ports, {
        trustedCaller: 'identity-service',
        correlationId: randomUUID(),
        dealId: born.dealId,
        pendingInviteId,
        principalId: randomUUID(),
        idempotencyKey: key(),
      }),
    );
    expect(failure?.code).toBe('INVITATION_EXPIRED');

    // The observing command latched terminal expiry rather than merely reporting it.
    const row = await dealRow(pool, born.dealId);
    expect(row.terminationReason).toBe('INVITATION_EXPIRED');
    expect(row.terminatedAt).not.toBeNull();
    expect(await auditEvents(pool, born.dealId)).toContain('INVITATION_EXPIRED');

    // The slot was never bound.
    const slot = await pool.query(
      `SELECT "principalId" FROM "DealPartySlot" WHERE "dealId"=$1 AND "slotKind"='COUNTERPARTY'`,
      [born.dealId],
    );
    expect(slot.rows[0]!.principalId).toBeNull();
  });

  it('spec001_e08_direct_r1_accept', async () => {
    const deal = await bornDeal(pool);
    const accepted = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    expect(accepted.agreementReady).toBe(true);
    expect(accepted.firstMutualAcceptance).toBe(true);

    const row = await dealRow(pool, deal.dealId);
    expect(row.firstMutualAcceptedAt).not.toBeNull();
    expect(row.version).toBe(2);
    const events = await auditEvents(pool, deal.dealId);
    // Exactly one readiness transition is recorded.
    expect(events.filter((event) => event === 'MUTUAL_ACCEPTANCE_REACHED')).toHaveLength(1);
  });

  it('spec001_e09_r1_reject_terminal', async () => {
    const deal = await bornDeal(pool);
    const rejected = await rejectCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    expect(rejected.terminationReason).toBe('REJECTED');

    // No successor is possible afterwards, and the terminal error exposes the reason (§20).
    const failure = await errorOf(() =>
      proposeChanges(pool, ports, {
        actorPrincipalId: deal.creatorId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        baseRevisionId: deal.revisionId,
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Try to continue'),
        idempotencyKey: key(),
      }),
    );
    expect(failure?.code).toBe('DEAL_TERMINATED');
    expect(failure?.details.terminationReason).toBe('REJECTED');
  });

  it('spec001_e11_view_does_not_block_withdrawal', async () => {
    const deal = await bornDeal(pool);
    // Reading the Deal is not a contractual response, so withdrawal remains available.
    await dealRow(pool, deal.dealId);
    await revisionRows(pool, deal.dealId);
    const withdrawn = await withdrawInvitation(pool, ports, {
      actorPrincipalId: deal.creatorId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    expect(withdrawn.terminationReason).toBe('INVITATION_WITHDRAWN');
    // No counterparty response row was fabricated.
    const responses = await responseRows(pool, deal.dealId);
    expect(responses).toHaveLength(1);
    expect(responses[0]!.principalId).toBe(deal.creatorId);
  });

  it('spec001_e19_invitation_withdraw_after_response_is_refused', async () => {
    const deal = await bornDeal(pool);
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: key(),
    });
    const failure = await errorOf(() =>
      withdrawInvitation(pool, ports, {
        actorPrincipalId: deal.creatorId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: key(),
      }),
    );
    expect(failure?.code).toBe('WITHDRAW_NOT_ALLOWED');
    expect(failure?.details.reason).toBe('COUNTERPARTY_ALREADY_RESPONDED');
  });

  it('spec001_e12_successor_proposal', async () => {
    const deal = await bornDeal(pool);
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { colour: 'red' }),
      idempotencyKey: key(),
    });
    expect(successor.revisionNumber).toBe(2);
    expect(successor.predecessorRevisionId).toBe(deal.revisionId);

    const revisions = await revisionRows(pool, deal.dealId);
    expect(revisions).toHaveLength(2);
    // The chain is linear and same-Deal, and R1 history is preserved.
    expect(revisions[1]!.predecessorRevisionId).toBe(revisions[0]!.id);

    const row = await dealRow(pool, deal.dealId);
    expect(row.currentRevisionId).toBe(successor.revisionId);

    // The proposer auto-accepts the successor in the same transaction.
    const responses = await responseRows(pool, deal.dealId);
    const auto = responses.find(
      (response) =>
        response.revisionId === successor.revisionId &&
        response.principalId === deal.counterpartyId,
    );
    expect(auto?.responseOrigin).toBe('REVISION_CREATOR_AUTO');
    expect(await auditEvents(pool, deal.dealId)).toContain('CURRENT_REVISION_ADVANCED');
  });

  it('spec001_e13_successor_accept_no_deadlock', async () => {
    const deal = await bornDeal(pool);
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { colour: 'blue' }),
      idempotencyKey: key(),
    });
    // The other participant accepts; the successor's creator needs no second Accept press.
    const accepted = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.creatorId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: successor.revisionId,
      idempotencyKey: key(),
    });
    expect(accepted.agreementReady).toBe(true);
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: successor.revisionId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('REVISION_ALREADY_RESPONDED');
  });

  it('spec001_e14_stale_accept_race', async () => {
    const deal = await bornDeal(pool);
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { colour: 'green' }),
      idempotencyKey: key(),
    });
    // A caller-supplied stale R1 target is never silently retargeted to R2.
    const failure = await errorOf(() =>
      acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.creatorId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: key(),
      }),
    );
    expect(failure?.code).toBe('REVISION_NOT_CURRENT');
    expect(failure?.details.expectedRevisionId).toBe(successor.revisionId);
    expect(failure?.details.actualRevisionId).toBe(deal.revisionId);

    const responses = await responseRows(pool, deal.dealId);
    expect(
      responses.filter((response) => response.revisionId === successor.revisionId),
    ).toHaveLength(1);
  });

  it('spec001_e16_turn_based_spam_blocked', async () => {
    const deal = await bornDeal(pool);
    // The creator authored R1 and holds its auto-ACCEPT, so they must wait for the counterpart.
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Creator tries to self-spam'),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('ACTOR_MUST_WAIT_FOR_COUNTERPARTY');
    expect(await revisionRows(pool, deal.dealId)).toHaveLength(1);
  });

  it('spec001_e17_unchanged_proposal_no_credit', async () => {
    const deal = await bornDeal(pool, { title: 'Unchanged terms deal' });
    // Same canonical (termsPayload, termsSchemaId) pair, written with different key order and
    // whitespace: canonically identical, so it is refused and consumes no credit.
    const reordered = new TextEncoder().encode(
      '{ "typeTerms" : { "note" : "inert business data" } , "common" : { "title" : "Unchanged terms deal" } }',
    );
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: reordered,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('REVISION_TERMS_UNCHANGED');

    // No successor exists, so no credit was consumed and the counterpart still has both.
    expect(await revisionRows(pool, deal.dealId)).toHaveLength(1);
    for (let index = 0; index < 2; index += 1) {
      const proposal = await proposeChanges(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        baseRevisionId: (await dealRow(pool, deal.dealId)).currentRevisionId,
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Unchanged terms deal', { round: index }),
        idempotencyKey: key(),
      });
      expect(proposal.revisionNumber).toBe(index + 2);
      if (index === 0)
        await acceptCurrentRevision(pool, ports, {
          actorPrincipalId: deal.creatorId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          targetRevisionId: proposal.revisionId,
          idempotencyKey: key(),
        });
    }
  });

  it('spec001_e18_modification_limits', async () => {
    const deal = await bornDeal(pool, { title: 'Credit limit deal' });
    const counterpartyProposals: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const current = (await dealRow(pool, deal.dealId)).currentRevisionId;
      const proposal = await proposeChanges(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        baseRevisionId: current,
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Credit limit deal', { counterpartyRound: index }),
        idempotencyKey: key(),
      });
      counterpartyProposals.push(proposal.revisionId);
      // Hand the turn back so the next proposal is not blocked by turn-taking instead.
      await acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.creatorId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: proposal.revisionId,
        idempotencyKey: key(),
      });
    }
    expect(counterpartyProposals).toHaveLength(2);

    // A third committed successor by the same Principal is refused.
    const currentAfterTwo = (await dealRow(pool, deal.dealId)).currentRevisionId;
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: currentAfterTwo,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('Credit limit deal', { counterpartyRound: 2 }),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('MODIFICATION_LIMIT_REACHED');

    // Credits are per participant: the creator's own two are untouched by the counterpart's use.
    const creatorProposal = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.creatorId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: currentAfterTwo,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Credit limit deal', { creatorRound: 0 }),
      idempotencyKey: key(),
    });
    expect(creatorProposal.revisionNumber).toBe(4);
  });

  it('spec001_e20_duplicate_accept_retry', async () => {
    const deal = await bornDeal(pool);
    const acceptKey = key();
    const first = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const replay = await acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.counterpartyId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: deal.revisionId,
        idempotencyKey: acceptKey,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.dealVersion).toBe(first.dealVersion);
    }
    // Replay appends no duplicate domain event and no extra version increment.
    const row = await dealRow(pool, deal.dealId);
    expect(row.version).toBe(2);
    const events = await auditEvents(pool, deal.dealId);
    expect(events.filter((event) => event === 'REVISION_ACCEPTED_EXPLICIT')).toHaveLength(1);
    expect(await responseRows(pool, deal.dealId)).toHaveLength(2);
  });

  it('spec001_e22_exact_expiry_boundary_single_db_time', async () => {
    const deal = await bornDeal(pool);
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

    const row = await dealRow(pool, deal.dealId);
    expect(row.terminationReason).toBe('INVITATION_EXPIRED');
    // Every timestamp written by the latching command came from the same command time.
    const events = await pool.query<{ commandTime: Date; eventType: string }>(
      `SELECT "commandTime","eventType"::text AS "eventType" FROM "DealAgreementAuditEvent"
        WHERE "dealId"=$1 AND "eventType"='INVITATION_EXPIRED'`,
      [deal.dealId],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0]!.commandTime.getTime()).toBe(row.terminatedAt.getTime());
    // No contractual response was recorded for the refused action.
    expect(await responseRows(pool, deal.dealId)).toHaveLength(1);
  });

  it('spec001_e23_mutual_accept_before_expiry_consumes_timer', async () => {
    const deal = await mutuallyAcceptedDeal(pool);
    // Push the original invitation deadline into the past *after* first mutual acceptance.
    const client = await pool.connect();
    try {
      await client.query('ALTER TABLE "Deal" DISABLE TRIGGER "Deal_update_guard"');
      await client.query(
        `UPDATE "Deal" SET "sentAt"="sentAt" - interval '169 hours',
                           "inviteExpiresAt"="inviteExpiresAt" - interval '169 hours'
          WHERE "id"=$1`,
        [deal.dealId],
      );
    } finally {
      await client
        .query('ALTER TABLE "Deal" ENABLE ALWAYS TRIGGER "Deal_update_guard"')
        .catch(() => undefined);
      client.release();
    }

    // The consumed timer can no longer terminalize the Deal, and negotiation still works.
    const materializer = await expireInvitationIfDue(pool, ports, {
      actorScope: 'SYSTEM:expiry',
      correlationId: randomUUID(),
      dealId: deal.dealId,
    });
    expect(materializer.outcome).toBe('NO_OP_TIMER_CONSUMED');

    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { amended: true }),
      idempotencyKey: key(),
    });
    expect(successor.revisionNumber).toBe(2);
    expect((await dealRow(pool, deal.dealId)).terminationReason).toBeNull();
  });

  it('spec001_e40_expiry_materializer_after_timer_consumed', async () => {
    const deal = await mutuallyAcceptedDeal(pool);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        expireInvitationIfDue(pool, ports, {
          actorScope: 'SYSTEM:expiry',
          correlationId: randomUUID(),
          dealId: deal.dealId,
        }),
      ),
    );
    for (const outcome of outcomes) expect(outcome.outcome).toBe('NO_OP_TIMER_CONSUMED');
    const row = await dealRow(pool, deal.dealId);
    expect(row.terminationReason).toBeNull();
    // No-op outcomes create no duplicate transition and no version churn.
    expect(row.version).toBe(2);
    expect(await auditEvents(pool, deal.dealId)).not.toContain('INVITATION_EXPIRED');
  });

  it('spec001_e24_reshare_cannot_move_invite_time', async () => {
    const deal = await bornDeal(pool);
    const before = await dealRow(pool, deal.dealId);
    // Re-observing the Deal repeatedly (the kernel equivalent of re-share/reminder) touches
    // nothing; there is no command that can move these fields at all.
    for (let index = 0; index < 3; index += 1)
      await expireInvitationIfDue(pool, ports, {
        actorScope: 'SYSTEM:reminder',
        correlationId: randomUUID(),
        dealId: deal.dealId,
      });
    const after = await dealRow(pool, deal.dealId);
    expect(after.sentAt.getTime()).toBe(before.sentAt.getTime());
    expect(after.inviteExpiresAt.getTime()).toBe(before.inviteExpiresAt.getTime());
    expect(after.version).toBe(before.version);
  });

  it('spec001_e25_r2_proposer_withdrawal', async () => {
    const deal = await bornDeal(pool);
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { revised: true }),
      idempotencyKey: key(),
    });
    // The R2 proposer, still waiting on the counterpart, may terminally withdraw.
    const withdrawn = await withdrawNegotiation(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: successor.revisionId,
      idempotencyKey: key(),
    });
    expect(withdrawn.terminationReason).toBe('NEGOTIATION_WITHDRAWN');

    const failure = await errorOf(() =>
      acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.creatorId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: successor.revisionId,
        idempotencyKey: key(),
      }),
    );
    expect(failure?.code).toBe('DEAL_TERMINATED');
    expect(failure?.details.terminationReason).toBe('NEGOTIATION_WITHDRAWN');
  });

  it('spec001_e27_roles_are_per_deal', async () => {
    const shared = randomUUID();
    const asBuyer = await createFormalDeal(pool, ports, {
      actorPrincipalId: shared,
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'BUYER',
      counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Buying a laptop'),
      idempotencyKey: key(),
    });
    const asSeller = await createFormalDeal(pool, ports, {
      actorPrincipalId: shared,
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'SELLER',
      counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Selling a monitor'),
      idempotencyKey: key(),
    });
    const roles = await pool.query<{ dealId: string; role: string }>(
      `SELECT "dealId","role"::text AS role FROM "DealPartySlot"
        WHERE "principalId"=$1 AND "slotKind"='CREATOR'`,
      [shared],
    );
    const byDeal = new Map(roles.rows.map((row) => [row.dealId, row.role]));
    // The same Principal holds different roles in different Deals; there is no account-level role.
    expect(byDeal.get(asBuyer.dealId)).toBe('BUYER');
    expect(byDeal.get(asSeller.dealId)).toBe('SELLER');
  });

  it('spec001_e37_unsupported_schema_fail_closed', async () => {
    // An unknown schema fails closed rather than being accepted as free-form business data.
    expect(
      await errorCodeOf(() =>
        createFormalDeal(pool, ports, {
          actorPrincipalId: randomUUID(),
          correlationId: randomUUID(),
          dealType: 'GOODS',
          creatorRole: 'BUYER',
          counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
          termsSchemaId: 'dhamani.unknown.v99',
          rawTerms: terms('Unknown schema'),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('UNSUPPORTED_TERMS_SCHEMA');

    // A real schema that belongs to another Deal type is a mismatch, not an unknown schema.
    expect(
      await errorCodeOf(() =>
        createFormalDeal(pool, ports, {
          actorPrincipalId: randomUUID(),
          correlationId: randomUUID(),
          dealType: 'GOODS',
          creatorRole: 'BUYER',
          counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
          termsSchemaId: 'dhamani.services.v1',
          rawTerms: terms('Wrong type schema'),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('TERMS_SCHEMA_MISMATCH');

    // R1 pins the schema: a successor may not migrate to a different known schema id.
    const deal = await bornDeal(pool);
    expect(
      await errorCodeOf(() =>
        proposeChanges(pool, ports, {
          actorPrincipalId: deal.counterpartyId,
          correlationId: randomUUID(),
          dealId: deal.dealId,
          baseRevisionId: deal.revisionId,
          termsSchemaId: 'dhamani.services.v1',
          rawTerms: terms('Schema migration attempt'),
          idempotencyKey: key(),
        }),
      ),
    ).toBe('TERMS_SCHEMA_MISMATCH');
  });

  it('spec001_e38_terms_authority_smuggling_is_inert', async () => {
    // Authority-looking keys at the closed top level are rejected outright.
    for (const smuggled of [
      '{"common":{"title":"Smuggle"},"typeTerms":{},"currentRevisionId":"x"}',
      '{"common":{"title":"Smuggle"},"typeTerms":{},"terminationReason":"REJECTED"}',
      '{"common":{"title":"Smuggle"},"typeTerms":{},"agreementReady":true}',
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

    // The same names inside typeTerms are accepted as inert business data and mutate nothing.
    const creatorId = randomUUID();
    const born = await createFormalDeal(pool, ports, {
      actorPrincipalId: creatorId,
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'BUYER',
      counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: new TextEncoder().encode(
        JSON.stringify({
          common: { title: 'Inert smuggling' },
          typeTerms: {
            agreementReady: true,
            terminationReason: 'REJECTED',
            version: 999,
            currentRevisionId: '00000000-0000-7000-8000-000000000000',
          },
        }),
      ),
      idempotencyKey: key(),
    });
    const row = await dealRow(pool, born.dealId);
    expect(row.terminationReason).toBeNull();
    expect(row.version).toBe(1);
    expect(row.currentRevisionId).toBe(born.currentRevisionId);
    expect(row.firstMutualAcceptedAt).toBeNull();
  });

  it('spec001_e42_idempotent_replay_after_later_state_change', async () => {
    const deal = await bornDeal(pool);
    const acceptKey = key();
    const accepted = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    // Advance the Deal well past that command.
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Bicycle purchase', { later: true }),
      idempotencyKey: key(),
    });
    const beforeReplay = await dealRow(pool, deal.dealId);

    // Replaying the historical command returns its ORIGINAL commit-time outcome and mutates
    // nothing newer — in particular it does not report the newer current revision.
    const replay = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.revisionId).toBe(deal.revisionId);
    expect(replay.revisionId).not.toBe(successor.revisionId);
    expect(replay.dealVersion).toBe(accepted.dealVersion);

    const afterReplay = await dealRow(pool, deal.dealId);
    expect(afterReplay.version).toBe(beforeReplay.version);
    expect(afterReplay.currentRevisionId).toBe(beforeReplay.currentRevisionId);
  });
});
