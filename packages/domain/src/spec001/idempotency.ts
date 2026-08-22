import { canonicalizeValue } from './json/jcs.js';
import type { Sha256 } from './ports.js';

/**
 * §22 — application command idempotency.
 *
 * Seven commands are keyed. `ExpireInvitationIfDue` is deliberately absent: it is
 * state-idempotent and takes no caller key (§9.2).
 */
export const KEYED_COMMANDS = [
  'CreateFormalDeal',
  'BindCounterpartyPrincipal',
  'AcceptCurrentRevision',
  'RejectCurrentRevision',
  'ProposeChanges',
  'WithdrawInvitation',
  'WithdrawNegotiation',
] as const;

export type KeyedCommand = (typeof KEYED_COMMANDS)[number];

/** §22.1 scope: participant commands are principal-scoped, trusted bind is caller-scoped. */
export function principalScope(principalId: string): string {
  return `PRINCIPAL:${principalId}`;
}

export function trustedIdentityScope(trustedCaller: string): string {
  return `TRUSTED_IDENTITY:${trustedCaller}`;
}

export type CounterpartyTarget =
  | Readonly<{ kind: 'PRINCIPAL'; principalId: string }>
  | Readonly<{ kind: 'PENDING_INVITE'; pendingInviteId: string }>;

/** Canonical union form used inside the CreateFormalDeal fingerprint. */
export function canonicalCounterpartyTarget(target: CounterpartyTarget): Record<string, string> {
  return target.kind === 'PRINCIPAL'
    ? { kind: 'PRINCIPAL', principalId: target.principalId }
    : { kind: 'PENDING_INVITE', pendingInviteId: target.pendingInviteId };
}

export type FingerprintInput =
  | Readonly<{
      commandType: 'CreateFormalDeal';
      dealType: string;
      creatorRole: string;
      counterpartyTarget: CounterpartyTarget;
      termsSchemaId: string;
      termsCanonicalSha256Hex: string;
    }>
  | Readonly<{
      commandType: 'BindCounterpartyPrincipal';
      dealId: string;
      pendingInviteId: string;
      principalId: string;
    }>
  | Readonly<{
      commandType: 'AcceptCurrentRevision' | 'RejectCurrentRevision';
      dealId: string;
      targetRevisionId: string;
    }>
  | Readonly<{
      commandType: 'ProposeChanges';
      dealId: string;
      baseRevisionId: string;
      termsSchemaId: string;
      termsCanonicalSha256Hex: string;
    }>
  | Readonly<{
      commandType: 'WithdrawInvitation' | 'WithdrawNegotiation';
      dealId: string;
      targetRevisionId: string;
    }>;

/**
 * §22.3 — the exact semantic fingerprint fields per command. `correlationId` is deliberately
 * excluded, so a retry that carries a new correlation id is still recognised as the same
 * semantic command rather than as a conflicting one.
 *
 * IDs are canonical lowercase hyphenated text; the fingerprint is JCS + SHA-256 over a fixed
 * command-specific schema.
 */
export function fingerprintPayload(input: FingerprintInput): Record<string, unknown> {
  switch (input.commandType) {
    case 'CreateFormalDeal':
      return {
        commandType: input.commandType,
        counterpartyTarget: canonicalCounterpartyTarget(input.counterpartyTarget),
        creatorRole: input.creatorRole,
        dealType: input.dealType,
        termsCanonicalSha256: input.termsCanonicalSha256Hex,
        termsSchemaId: input.termsSchemaId,
      };
    case 'BindCounterpartyPrincipal':
      return {
        commandType: input.commandType,
        dealId: input.dealId,
        pendingInviteId: input.pendingInviteId,
        principalId: input.principalId,
      };
    case 'ProposeChanges':
      return {
        baseRevisionId: input.baseRevisionId,
        commandType: input.commandType,
        dealId: input.dealId,
        termsCanonicalSha256: input.termsCanonicalSha256Hex,
        termsSchemaId: input.termsSchemaId,
      };
    default:
      return {
        commandType: input.commandType,
        dealId: input.dealId,
        targetRevisionId: input.targetRevisionId,
      };
  }
}

export function computeIdempotencyFingerprint(input: FingerprintInput, sha256: Sha256): Uint8Array {
  const canonical = canonicalizeValue(fingerprintPayload(input));
  return sha256(new TextEncoder().encode(canonical));
}
