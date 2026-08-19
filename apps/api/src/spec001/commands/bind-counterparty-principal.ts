import type pg from 'pg';
import {
  Spec001Error,
  computeIdempotencyFingerprint,
  currentRevision,
  requireCanonicalUuid,
  slotOf,
  trustedIdentityScope,
  type KernelPorts,
} from '@dhamani/domain';
import {
  appendAuditEvent,
  assertCurrentRevisionIntegrity,
  bindCounterpartySlot,
  updateDeal,
} from '../repository.js';
import { runKeyedDealCommand } from './shared.js';

export type BindCounterpartyPrincipalInput = Readonly<{
  /** Stable identifier of the trusted internal Identity/Application boundary making the call. */
  trustedCaller: string;
  correlationId: string;
  dealId: string;
  pendingInviteId: string;
  principalId: string;
  idempotencyKey: string;
}>;

export type BindCounterpartyPrincipalResult = Readonly<{
  dealId: string;
  principalId: string;
  dealVersion: number;
  replayed: boolean;
}>;

/**
 * §8 — `BindCounterpartyPrincipal`, the one-time trusted binding of a pending COUNTERPARTY slot.
 *
 * The `pendingInviteId` is an opaque, Deal-scoped value that is not a bearer secret: possession
 * alone grants no authority, and no user-accessible link or token can perform this binding. It is
 * preserved after binding as immutable provenance rather than cleared.
 */
export async function bindCounterpartyPrincipal(
  pool: pg.Pool,
  ports: KernelPorts,
  input: BindCounterpartyPrincipalInput,
): Promise<BindCounterpartyPrincipalResult> {
  const dealId = requireCanonicalUuid(input.dealId, 'dealId');
  const pendingInviteId = requireCanonicalUuid(input.pendingInviteId, 'pendingInviteId');
  const principalId = requireCanonicalUuid(input.principalId, 'principalId');
  requireCanonicalUuid(input.correlationId, 'correlationId');
  if (input.trustedCaller.length === 0)
    throw new Spec001Error('VALIDATION_ERROR', { field: 'trustedCaller', reason: 'REQUIRED' });

  return runKeyedDealCommand<BindCounterpartyPrincipalResult>(pool, ports, {
    commandType: 'BindCounterpartyPrincipal',
    scope: trustedIdentityScope(input.trustedCaller),
    idempotencyKey: input.idempotencyKey,
    fingerprint: computeIdempotencyFingerprint(
      { commandType: 'BindCounterpartyPrincipal', dealId, pendingInviteId, principalId },
      ports.sha256,
    ),
    dealId,
    correlationId: input.correlationId,
    actorScope: trustedIdentityScope(input.trustedCaller),
    replay: (facts) => ({
      dealId: String(facts.dealId),
      principalId: String(facts.principalId),
      dealVersion: Number(facts.dealVersion),
      replayed: true,
    }),
    execute: async ({ sql, snapshot, commandTime, dealRow, actorScope, correlationId }) => {
      await assertCurrentRevisionIntegrity(
        sql,
        dealId,
        dealRow.dealType,
        currentRevision(snapshot).id,
        ports,
      );

      const counterparty = slotOf(snapshot, 'COUNTERPARTY');
      // A bound Principal is never replaced, so a later different Principal is a stable typed
      // rejection rather than a silent rebind.
      if (counterparty.principalId !== null) throw new Spec001Error('COUNTERPARTY_ALREADY_BOUND');
      if (counterparty.pendingInviteId !== pendingInviteId)
        throw new Spec001Error('PENDING_INVITE_MISMATCH');

      const creator = slotOf(snapshot, 'CREATOR');
      if (creator.principalId === principalId)
        throw new Spec001Error('SAME_PARTICIPANT_BOTH_SIDES');

      const bound = await bindCounterpartySlot(sql, {
        dealId,
        pendingInviteId,
        principalId,
        commandTime,
      });
      if (!bound) throw new Spec001Error('COUNTERPARTY_ALREADY_BOUND');

      const dealVersion = await updateDeal(sql, dealId, dealRow.version, {});
      await appendAuditEvent(sql, ports, {
        dealId,
        eventType: 'COUNTERPARTY_BOUND',
        actorScope,
        targetRevisionId: dealRow.currentRevisionId,
        commandTime,
        dealVersion,
        correlationId,
        // Safe metadata only: no raw phone/email/username ever reaches the audit trail (§26).
        metadata: { slotKind: 'COUNTERPARTY' },
      });

      return {
        result: { dealId, principalId, dealVersion, replayed: false },
        storedFacts: { dealId, principalId, dealVersion },
      };
    },
  });
}
