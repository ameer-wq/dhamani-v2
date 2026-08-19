import type pg from 'pg';
import {
  Spec001Error,
  computeIdempotencyFingerprint,
  counterpartyHasContractuallyResponded,
  currentRevision,
  deriveAgreementReady,
  principalScope,
  requireCanonicalUuid,
  responseBy,
  slotOf,
  type KernelPorts,
} from '@dhamani/domain';
import { appendAuditEvent, assertCurrentRevisionIntegrity, updateDeal } from '../repository.js';
import { runKeyedDealCommand } from './shared.js';

export type WithdrawInput = Readonly<{
  actorPrincipalId: string;
  correlationId: string;
  dealId: string;
  targetRevisionId: string;
  idempotencyKey: string;
}>;

export type WithdrawResult = Readonly<{
  dealId: string;
  revisionId: string;
  dealVersion: number;
  terminationReason: 'INVITATION_WITHDRAWN' | 'NEGOTIATION_WITHDRAWN';
  replayed: boolean;
}>;

type WithdrawKind = 'WithdrawInvitation' | 'WithdrawNegotiation';

async function withdraw(
  pool: pg.Pool,
  ports: KernelPorts,
  input: WithdrawInput,
  commandType: WithdrawKind,
  terminationReason: 'INVITATION_WITHDRAWN' | 'NEGOTIATION_WITHDRAWN',
  auditEventType: 'INVITATION_WITHDRAWN' | 'NEGOTIATION_WITHDRAWN',
  assertPreconditions: (context: {
    snapshot: Parameters<typeof deriveAgreementReady>[0];
    commandTime: Date;
    actorPrincipalId: string;
  }) => void,
): Promise<WithdrawResult> {
  const actorPrincipalId = requireCanonicalUuid(input.actorPrincipalId, 'actorPrincipalId');
  const dealId = requireCanonicalUuid(input.dealId, 'dealId');
  const targetRevisionId = requireCanonicalUuid(input.targetRevisionId, 'targetRevisionId');
  requireCanonicalUuid(input.correlationId, 'correlationId');

  return runKeyedDealCommand<WithdrawResult>(pool, ports, {
    commandType,
    scope: principalScope(actorPrincipalId),
    idempotencyKey: input.idempotencyKey,
    fingerprint: computeIdempotencyFingerprint(
      { commandType, dealId, targetRevisionId },
      ports.sha256,
    ),
    dealId,
    correlationId: input.correlationId,
    actorScope: principalScope(actorPrincipalId),
    replay: (facts) => ({
      dealId: String(facts.dealId),
      revisionId: String(facts.revisionId),
      dealVersion: Number(facts.dealVersion),
      terminationReason,
      replayed: true,
    }),
    execute: async ({ sql, snapshot, commandTime, dealRow, actorScope, correlationId }) => {
      const target = snapshot.revisions.find((revision) => revision.id === targetRevisionId);
      if (!target) throw new Spec001Error('REVISION_NOT_FOUND');
      const current = currentRevision(snapshot);
      if (target.id !== current.id)
        throw new Spec001Error('REVISION_NOT_CURRENT', {
          expectedRevisionId: current.id,
          actualRevisionId: target.id,
        });

      await assertCurrentRevisionIntegrity(sql, dealId, dealRow.dealType, current.id, ports);
      assertPreconditions({ snapshot, commandTime, actorPrincipalId });

      const dealVersion = await updateDeal(sql, dealId, dealRow.version, {
        terminationReason,
        terminatedAt: commandTime,
      });
      await appendAuditEvent(sql, ports, {
        dealId,
        eventType: auditEventType,
        actorScope,
        targetRevisionId: current.id,
        commandTime,
        dealVersion,
        correlationId,
        metadata: { revisionNumber: current.revisionNumber, terminationReason },
      });

      return {
        result: {
          dealId,
          revisionId: current.id,
          dealVersion,
          terminationReason,
          replayed: false,
        },
        storedFacts: { dealId, revisionId: current.id, dealVersion, terminationReason },
      };
    },
  });
}

/**
 * §19.1 — `WithdrawInvitation`. Allowed only for R1, by the original creator, and only before the
 * counterparty has made a contractual response. Viewing or opening the invitation is explicitly
 * irrelevant: it is not a contractual response, so it never blocks withdrawal (E11).
 *
 * No counterparty response row is fabricated by this command.
 */
export async function withdrawInvitation(
  pool: pg.Pool,
  ports: KernelPorts,
  input: WithdrawInput,
): Promise<WithdrawResult> {
  return withdraw(
    pool,
    ports,
    input,
    'WithdrawInvitation',
    'INVITATION_WITHDRAWN',
    'INVITATION_WITHDRAWN',
    ({ snapshot, actorPrincipalId }) => {
      const creatorSlot = slotOf(snapshot, 'CREATOR');
      if (creatorSlot.principalId !== actorPrincipalId)
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', { reason: 'NOT_ORIGINAL_CREATOR' });
      const current = currentRevision(snapshot);
      if (current.revisionNumber !== 1)
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', { reason: 'NOT_R1' });
      if (counterpartyHasContractuallyResponded(snapshot, actorPrincipalId))
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', {
          reason: 'COUNTERPARTY_ALREADY_RESPONDED',
        });
    },
  );
}

/**
 * §19.2 — `WithdrawNegotiation`. Allowed only when the current revision is R2+, the actor created
 * that exact current revision and holds its auto-ACCEPT, the counterpart has not responded, and
 * the revision is not mutually accepted.
 */
export async function withdrawNegotiation(
  pool: pg.Pool,
  ports: KernelPorts,
  input: WithdrawInput,
): Promise<WithdrawResult> {
  return withdraw(
    pool,
    ports,
    input,
    'WithdrawNegotiation',
    'NEGOTIATION_WITHDRAWN',
    'NEGOTIATION_WITHDRAWN',
    ({ snapshot, commandTime, actorPrincipalId }) => {
      const current = currentRevision(snapshot);
      if (current.revisionNumber < 2)
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', { reason: 'NOT_SUCCESSOR_REVISION' });
      if (current.createdByPrincipalId !== actorPrincipalId)
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', { reason: 'NOT_CURRENT_PROPOSER' });
      const own = responseBy(snapshot, current.id, actorPrincipalId);
      if (!own || own.responseOrigin !== 'REVISION_CREATOR_AUTO')
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', { reason: 'MISSING_AUTO_ACCEPT' });
      const counterpartResponded = snapshot.responses.some(
        (response) =>
          response.revisionId === current.id && response.principalId !== actorPrincipalId,
      );
      if (counterpartResponded)
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', { reason: 'COUNTERPART_ALREADY_RESPONDED' });
      if (deriveAgreementReady(snapshot, commandTime))
        throw new Spec001Error('WITHDRAW_NOT_ALLOWED', { reason: 'ALREADY_MUTUALLY_ACCEPTED' });
    },
  );
}
