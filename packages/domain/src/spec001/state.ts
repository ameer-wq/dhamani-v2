import { Spec001Error, type TerminationReason } from './errors.js';
import type { DealType, PartyRole, SlotKind } from './deal-types.js';

/**
 * Pure derivation of Deal-scoped truth. Everything here is computed from immutable history and
 * the single authoritative `commandTime`; nothing is read from a mutable convenience flag.
 */

export const MAX_SUCCESSOR_CREDITS_PER_PARTICIPANT = 2;

export type DealState = Readonly<{
  id: string;
  dealType: DealType;
  currentRevisionId: string;
  sentAt: Date;
  inviteExpiresAt: Date;
  firstMutualAcceptedAt: Date | null;
  terminationReason: TerminationReason | null;
  terminatedAt: Date | null;
  version: number;
}>;

export type SlotState = Readonly<{
  slotKind: SlotKind;
  role: PartyRole;
  principalId: string | null;
  pendingInviteId: string | null;
  boundAt: Date | null;
}>;

export type RevisionState = Readonly<{
  id: string;
  revisionNumber: number;
  predecessorRevisionId: string | null;
  createdByPrincipalId: string;
  termsSchemaId: string;
}>;

export type ResponseState = Readonly<{
  revisionId: string;
  principalId: string;
  responseKind: 'ACCEPT' | 'REJECT';
  responseOrigin: 'EXPLICIT' | 'REVISION_CREATOR_AUTO';
}>;

export type DealSnapshot = Readonly<{
  deal: DealState;
  slots: readonly SlotState[];
  revisions: readonly RevisionState[];
  responses: readonly ResponseState[];
}>;

/**
 * §9 — effective expiry is exactly `firstMutualAcceptedAt IS NULL AND commandTime >= inviteExpiresAt`.
 *
 * Once first mutual acceptance is committed the invitation timer is permanently consumed, so a
 * long later negotiation can never be killed by the original invite deadline.
 */
export function isEffectivelyExpired(deal: DealState, commandTime: Date): boolean {
  if (deal.firstMutualAcceptedAt !== null) return false;
  return commandTime.getTime() >= deal.inviteExpiresAt.getTime();
}

export function isTerminal(deal: DealState): boolean {
  return deal.terminationReason !== null;
}

export function slotOf(snapshot: DealSnapshot, slotKind: SlotKind): SlotState {
  const slot = snapshot.slots.find((candidate) => candidate.slotKind === slotKind);
  if (!slot) throw new Spec001Error('VALIDATION_ERROR', { reason: 'SLOT_MISSING' });
  return slot;
}

export function boundPrincipals(snapshot: DealSnapshot): readonly string[] {
  return snapshot.slots
    .map((slot) => slot.principalId)
    .filter((principalId): principalId is string => principalId !== null);
}

export function isBoundParticipant(snapshot: DealSnapshot, principalId: string): boolean {
  return boundPrincipals(snapshot).includes(principalId);
}

export function currentRevision(snapshot: DealSnapshot): RevisionState {
  const revision = snapshot.revisions.find(
    (candidate) => candidate.id === snapshot.deal.currentRevisionId,
  );
  if (!revision) throw new Spec001Error('REVISION_NOT_FOUND');
  return revision;
}

export function responsesFor(snapshot: DealSnapshot, revisionId: string): readonly ResponseState[] {
  return snapshot.responses.filter((response) => response.revisionId === revisionId);
}

export function responseBy(
  snapshot: DealSnapshot,
  revisionId: string,
  principalId: string,
): ResponseState | undefined {
  return snapshot.responses.find(
    (response) => response.revisionId === revisionId && response.principalId === principalId,
  );
}

/**
 * §18 — `agreementReady` is always server-derived and never client-authored. Each condition is
 * independently falsifying, which is what INV-001-016 requires evidence for.
 */
export function deriveAgreementReady(snapshot: DealSnapshot, commandTime: Date): boolean {
  const { deal } = snapshot;
  if (isTerminal(deal)) return false;
  if (isEffectivelyExpired(deal, commandTime)) return false;
  const principals = boundPrincipals(snapshot);
  if (principals.length !== 2) return false;
  if (new Set(principals).size !== 2) return false;
  const current = snapshot.revisions.find((candidate) => candidate.id === deal.currentRevisionId);
  if (!current) return false;
  return principals.every((principalId) => {
    const response = responseBy(snapshot, current.id, principalId);
    return response !== undefined && response.responseKind === 'ACCEPT';
  });
}

/**
 * §17.3 — modification credits are derived from immutable history: only *committed* successors
 * authored by that Principal consume one. R1 consumes none. Nothing else — failed validation,
 * unchanged terms, turn violations, stale losses, replays or rejections — can consume a credit,
 * because none of them leave a committed successor behind.
 */
export function committedSuccessorCredits(snapshot: DealSnapshot, principalId: string): number {
  return snapshot.revisions.filter(
    (revision) => revision.revisionNumber >= 2 && revision.createdByPrincipalId === principalId,
  ).length;
}

export function hasRemainingCredits(snapshot: DealSnapshot, principalId: string): boolean {
  return committedSuccessorCredits(snapshot, principalId) < MAX_SUCCESSOR_CREDITS_PER_PARTICIPANT;
}

/**
 * §17.2 — turn-taking. While the current revision is not mutually accepted, only the *other*
 * participant may act on it, so a revision creator cannot spam successors while waiting. Once it
 * is mutually accepted and the Deal is not terminal, either participant may propose a successor.
 */
export function actorMayActOnCurrentRevision(
  snapshot: DealSnapshot,
  principalId: string,
  commandTime: Date,
): boolean {
  if (deriveAgreementReady(snapshot, commandTime)) return true;
  return currentRevision(snapshot).createdByPrincipalId !== principalId;
}

/** The participant whose contractual decision the current revision is waiting on, if any. */
export function awaitedPrincipal(snapshot: DealSnapshot): string | undefined {
  const current = currentRevision(snapshot);
  return boundPrincipals(snapshot).find(
    (principalId) => responseBy(snapshot, current.id, principalId) === undefined,
  );
}

/** §19.1 — a contractual response is ACCEPT or REJECT. Viewing or opening is not one (E11). */
export function counterpartyHasContractuallyResponded(
  snapshot: DealSnapshot,
  creatorPrincipalId: string,
): boolean {
  return snapshot.responses.some(
    (response) =>
      response.principalId !== creatorPrincipalId && response.responseOrigin === 'EXPLICIT',
  );
}

export function nextRevisionNumber(snapshot: DealSnapshot): number {
  return (
    snapshot.revisions.reduce(
      (highest, revision) => Math.max(highest, revision.revisionNumber),
      0,
    ) + 1
  );
}
