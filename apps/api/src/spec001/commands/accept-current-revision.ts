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
import type { KernelDatabase } from '../database.js';
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

/**
 * §22.5 — the immutable event/result kind committed by a successful Accept.
 *
 * §22.5 permits storing an "event/result kind" and explicitly forbids storing a live-derived
 * projection such as `agreementReady`. This enum is that permitted kind: it records what the
 * command *did* at commit time and can never drift, whereas a stored readiness flag would be a
 * projection of Deal state. The caller-facing booleans are derived from it, so historical replay
 * reproduces the original outcome without consulting current Deal state (E42 / INV-001-046).
 */
export const ACCEPT_RESULT_KINDS = [
  'ACCEPT_RECORDED',
  'MUTUAL_ACCEPTANCE_REACHED',
  'FIRST_MUTUAL_ACCEPTANCE_REACHED',
] as const;

export type AcceptResultKind = (typeof ACCEPT_RESULT_KINDS)[number];

function acceptResultKind(
  mutuallyAccepted: boolean,
  firstEverTransition: boolean,
): AcceptResultKind {
  if (!mutuallyAccepted) return 'ACCEPT_RECORDED';
  return firstEverTransition ? 'FIRST_MUTUAL_ACCEPTANCE_REACHED' : 'MUTUAL_ACCEPTANCE_REACHED';
}

/** Derives the caller-facing booleans from the immutable committed result kind. */
function acceptOutcomeOf(kind: AcceptResultKind): {
  agreementReady: boolean;
  firstMutualAcceptance: boolean;
} {
  return {
    agreementReady: kind !== 'ACCEPT_RECORDED',
    firstMutualAcceptance: kind === 'FIRST_MUTUAL_ACCEPTANCE_REACHED',
  };
}

export type AcceptCurrentRevisionResult = Readonly<{
  dealId: string;
  revisionId: string;
  revisionNumber: number;
  dealVersion: number;
  /** The immutable committed result kind; the booleans below are derived from it. */
  resultKind: AcceptResultKind;
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
  pool: KernelDatabase,
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
    replay: (facts) => {
      // Decoded purely from immutable commit-time facts. Nothing here reads current Deal state,
      // so a replay after later transitions still returns the original committed outcome.
      const resultKind = facts.resultKind as AcceptResultKind;
      return {
        dealId: String(facts.dealId),
        revisionId: String(facts.revisionId),
        revisionNumber: Number(facts.revisionNumber),
        dealVersion: Number(facts.dealVersion),
        resultKind,
        ...acceptOutcomeOf(resultKind),
        replayed: true,
      };
    },
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

      const resultKind = acceptResultKind(agreementReady, firstMutualAcceptance);
      return {
        result: {
          dealId,
          revisionId: current.id,
          revisionNumber: current.revisionNumber,
          dealVersion,
          resultKind,
          ...acceptOutcomeOf(resultKind),
          replayed: false,
        },
        // §22.5 — IDs, revision number, the authoritative Deal version and the immutable
        // event/result kind only. No `agreementReady` and no terminal-state projection.
        storedFacts: {
          dealId,
          revisionId: current.id,
          revisionNumber: current.revisionNumber,
          dealVersion,
          resultKind,
        },
      };
    },
  });
}
