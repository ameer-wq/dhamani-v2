import type pg from 'pg';
import {
  Spec001Error,
  computeIdempotencyFingerprint,
  currentRevision,
  deriveAgreementReady,
  isBoundParticipant,
  principalScope,
  requireCanonicalUuid,
  responseBy,
  type KernelPorts,
} from '@dhamani/domain';
import {
  appendAuditEvent,
  assertCurrentRevisionIntegrity,
  insertResponse,
  updateDeal,
} from '../repository.js';
import { runKeyedDealCommand } from './shared.js';

export type AcceptCurrentRevisionInput = Readonly<{
  actorPrincipalId: string;
  correlationId: string;
  dealId: string;
  /** Caller's exact contractual intent. Never defaulted or retargeted from currentRevisionId. */
  targetRevisionId: string;
  idempotencyKey: string;
}>;

export type AcceptCurrentRevisionResult = Readonly<{
  dealId: string;
  revisionId: string;
  dealVersion: number;
  agreementReady: boolean;
  firstMutualAcceptance: boolean;
  replayed: boolean;
}>;

/**
 * §15 — `AcceptCurrentRevision`.
 *
 * `targetRevisionId` is the caller's exact contractual intent and is NEVER defaulted, replaced or
 * retargeted from `Deal.currentRevisionId`. A stale target fails typed rather than silently
 * accepting whatever the current revision happens to be (E14).
 */
export async function acceptCurrentRevision(
  pool: pg.Pool,
  ports: KernelPorts,
  input: AcceptCurrentRevisionInput,
): Promise<AcceptCurrentRevisionResult> {
  const actorPrincipalId = requireCanonicalUuid(input.actorPrincipalId, 'actorPrincipalId');
  const dealId = requireCanonicalUuid(input.dealId, 'dealId');
  const targetRevisionId = requireCanonicalUuid(input.targetRevisionId, 'targetRevisionId');
  requireCanonicalUuid(input.correlationId, 'correlationId');

  return runKeyedDealCommand<AcceptCurrentRevisionResult>(pool, ports, {
    commandType: 'AcceptCurrentRevision',
    scope: principalScope(actorPrincipalId),
    idempotencyKey: input.idempotencyKey,
    fingerprint: computeIdempotencyFingerprint(
      { commandType: 'AcceptCurrentRevision', dealId, targetRevisionId },
      ports.sha256,
    ),
    dealId,
    correlationId: input.correlationId,
    actorScope: principalScope(actorPrincipalId),
    replay: (facts) => ({
      dealId: String(facts.dealId),
      revisionId: String(facts.revisionId),
      dealVersion: Number(facts.dealVersion),
      agreementReady: Boolean(facts.agreementReady),
      firstMutualAcceptance: Boolean(facts.firstMutualAcceptance),
      replayed: true,
    }),
    execute: async ({ sql, snapshot, commandTime, dealRow, actorScope, correlationId }) => {
      // 7. actor authorization and required binding
      if (!isBoundParticipant(snapshot, actorPrincipalId))
        throw new Spec001Error('NOT_DEAL_PARTICIPANT');

      // 8-9. target exists, belongs to this Deal, and is the exact current revision
      const target = snapshot.revisions.find((revision) => revision.id === targetRevisionId);
      if (!target) throw new Spec001Error('REVISION_NOT_FOUND');
      const current = currentRevision(snapshot);
      if (target.id !== current.id)
        throw new Spec001Error('REVISION_NOT_CURRENT', {
          expectedRevisionId: current.id,
          actualRevisionId: target.id,
        });

      // 10. current-revision integrity must pass before any requested mutation
      await assertCurrentRevisionIntegrity(sql, dealId, dealRow.dealType, current.id, ports);

      // 11. the actor must not already have a response to this exact revision — including the
      // auto-ACCEPT they received for authoring it (§14): no second Accept press is needed.
      if (responseBy(snapshot, current.id, actorPrincipalId))
        throw new Spec001Error('REVISION_ALREADY_RESPONDED');

      await insertResponse(sql, ports, {
        dealId,
        revisionId: current.id,
        principalId: actorPrincipalId,
        responseKind: 'ACCEPT',
        responseOrigin: 'EXPLICIT',
        commandTime,
      });

      const afterAccept = {
        ...snapshot,
        responses: [
          ...snapshot.responses,
          {
            revisionId: current.id,
            principalId: actorPrincipalId,
            responseKind: 'ACCEPT' as const,
            responseOrigin: 'EXPLICIT' as const,
          },
        ],
      };
      const agreementReady = deriveAgreementReady(afterAccept, commandTime);
      // §18 — firstMutualAcceptedAt is set exactly once, on the first readiness transition ever.
      const firstMutualAcceptance = agreementReady && snapshot.deal.firstMutualAcceptedAt === null;

      // §23.4 — one Deal update carrying exactly one version increment for the whole command.
      const dealVersion = await updateDeal(sql, dealId, dealRow.version, {
        ...(firstMutualAcceptance ? { firstMutualAcceptedAt: commandTime } : {}),
      });

      await appendAuditEvent(sql, ports, {
        dealId,
        eventType: 'REVISION_ACCEPTED_EXPLICIT',
        actorScope,
        targetRevisionId: current.id,
        commandTime,
        dealVersion,
        correlationId,
        metadata: { revisionNumber: current.revisionNumber },
      });
      if (agreementReady)
        await appendAuditEvent(sql, ports, {
          dealId,
          eventType: 'MUTUAL_ACCEPTANCE_REACHED',
          actorScope,
          targetRevisionId: current.id,
          commandTime,
          dealVersion,
          correlationId,
          metadata: { revisionNumber: current.revisionNumber, firstMutualAcceptance },
        });

      return {
        result: {
          dealId,
          revisionId: current.id,
          dealVersion,
          agreementReady,
          firstMutualAcceptance,
          replayed: false,
        },
        storedFacts: {
          dealId,
          revisionId: current.id,
          dealVersion,
          agreementReady,
          firstMutualAcceptance,
        },
      };
    },
  });
}
