import {
  Spec001Error,
  computeIdempotencyFingerprint,
  currentRevision,
  isBoundParticipant,
  principalScope,
  requireCanonicalUuid,
  responseBy,
  type KernelPorts,
} from '@dhamani/domain';
import type { KernelDatabase } from '../database.js';
import {
  appendAuditEvent,
  assertCurrentRevisionIntegrity,
  insertResponse,
  updateDeal,
} from '../repository.js';
import { runKeyedDealCommand } from './shared.js';

export type RejectCurrentRevisionInput = Readonly<{
  actorPrincipalId: string;
  correlationId: string;
  dealId: string;
  targetRevisionId: string;
  idempotencyKey: string;
}>;

export type RejectCurrentRevisionResult = Readonly<{
  dealId: string;
  revisionId: string;
  dealVersion: number;
  terminationReason: 'REJECTED';
  replayed: boolean;
}>;

/**
 * §16 — `RejectCurrentRevision`. Founder-closed: Reject is terminal for the Deal negotiation.
 *
 * The caller-supplied target is never retargeted from currentRevisionId, and current-revision
 * integrity must pass before the requested mutation. Anti-abuse cooldown is deliberately outside
 * SPEC-001; history preserves enough context for a later policy.
 */
export async function rejectCurrentRevision(
  pool: KernelDatabase,
  ports: KernelPorts,
  input: RejectCurrentRevisionInput,
): Promise<RejectCurrentRevisionResult> {
  const actorPrincipalId = requireCanonicalUuid(input.actorPrincipalId, 'actorPrincipalId');
  const dealId = requireCanonicalUuid(input.dealId, 'dealId');
  const targetRevisionId = requireCanonicalUuid(input.targetRevisionId, 'targetRevisionId');
  requireCanonicalUuid(input.correlationId, 'correlationId');

  return runKeyedDealCommand<RejectCurrentRevisionResult>(pool, ports, {
    commandType: 'RejectCurrentRevision',
    scope: principalScope(actorPrincipalId),
    idempotencyKey: input.idempotencyKey,
    fingerprint: computeIdempotencyFingerprint(
      { commandType: 'RejectCurrentRevision', dealId, targetRevisionId },
      ports.sha256,
    ),
    dealId,
    correlationId: input.correlationId,
    actorScope: principalScope(actorPrincipalId),
    // Decoded from the immutable committed result kind, never from current Deal state (§22.5).
    replay: (facts) => ({
      dealId: String(facts.dealId),
      revisionId: String(facts.revisionId),
      dealVersion: Number(facts.dealVersion),
      terminationReason: 'REJECTED',
      replayed: true,
    }),
    execute: async ({ sql, snapshot, commandTime, dealRow, actorScope, correlationId }) => {
      if (!isBoundParticipant(snapshot, actorPrincipalId))
        throw new Spec001Error('NOT_DEAL_PARTICIPANT');

      const target = snapshot.revisions.find((revision) => revision.id === targetRevisionId);
      if (!target) throw new Spec001Error('REVISION_NOT_FOUND');
      const current = currentRevision(snapshot);
      if (target.id !== current.id)
        throw new Spec001Error('REVISION_NOT_CURRENT', {
          expectedRevisionId: current.id,
          actualRevisionId: target.id,
        });

      await assertCurrentRevisionIntegrity(sql, dealId, dealRow.dealType, current.id, ports);

      if (responseBy(snapshot, current.id, actorPrincipalId))
        throw new Spec001Error('REVISION_ALREADY_RESPONDED');

      await insertResponse(sql, ports, {
        dealId,
        revisionId: current.id,
        principalId: actorPrincipalId,
        responseKind: 'REJECT',
        responseOrigin: 'EXPLICIT',
        commandTime,
      });

      const dealVersion = await updateDeal(sql, dealId, dealRow.version, {
        terminationReason: 'REJECTED',
        terminatedAt: commandTime,
      });

      await appendAuditEvent(sql, ports, {
        dealId,
        eventType: 'REVISION_REJECTED',
        actorScope,
        targetRevisionId: current.id,
        commandTime,
        dealVersion,
        correlationId,
        metadata: { revisionNumber: current.revisionNumber, terminationReason: 'REJECTED' },
      });

      return {
        result: {
          dealId,
          revisionId: current.id,
          dealVersion,
          terminationReason: 'REJECTED' as const,
          replayed: false,
        },
        // §22.5 — IDs, revision number, Deal version and the immutable event/result kind this
        // command committed. Not a projection of whatever the Deal's terminal state is now.
        storedFacts: {
          dealId,
          revisionId: current.id,
          revisionNumber: current.revisionNumber,
          dealVersion,
          resultKind: 'REJECTED',
        },
      };
    },
  });
}
