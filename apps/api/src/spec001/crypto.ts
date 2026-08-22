import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { KernelPorts } from '@dhamani/domain';

/**
 * Infrastructure adapters for the domain capability ports.
 *
 * These live outside the domain package because the domain is pure TypeScript with no
 * infrastructure imports (§ boundaries), and because evidence must be able to substitute
 * deterministic generators without any production back door existing.
 */

export function sha256(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

/**
 * UUIDv7 (RFC 9562): 48-bit big-endian Unix millisecond timestamp, 4-bit version, 12 bits of
 * randomness, 2-bit variant, then 62 further random bits.
 *
 * §6.1 requires every SPEC-001-minted entity ID to come from reviewed server code. No command
 * accepts a caller-supplied ID and no SPEC-001 table carries a DB-side random UUID default, so
 * a UUIDv4 can never be silently emitted in their place.
 */
export function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  const timestamp = BigInt(now);
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  const random = randomBytes(10);
  bytes.set(random, 6);
  // Version 7 in the high nibble of byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // RFC 4122 variant (10xx) in the high bits of byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Crockford Base32 alphabet: digits plus uppercase letters excluding I, L, O and U. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * §6.2 — `DH-XXXX-XXXX-XXXX`, 12 Crockford Base32 characters (60 random bits) drawn from
 * cryptographically secure random bytes. Generation and storage are uppercase canonical and no
 * normalization is applied. The reference is not an authorization secret.
 */
export function publicDealReference(): string {
  // Rejection sampling keeps the character distribution uniform over the 32-symbol alphabet.
  const characters: string[] = [];
  while (characters.length < 12) {
    for (const byte of randomBytes(16)) {
      if (characters.length === 12) break;
      const value = byte & 0x1f;
      if (byte >= 0xe0) continue; // 0..223 maps evenly onto 32 symbols; discard the tail.
      characters.push(CROCKFORD_ALPHABET.charAt(value));
    }
  }
  const group = (start: number): string => characters.slice(start, start + 4).join('');
  return `DH-${group(0)}-${group(4)}-${group(8)}`;
}

/** A fresh correlation id for internal callers that do not already carry one. */
export function newCorrelationId(): string {
  return randomUUID();
}

export const productionKernelPorts: KernelPorts = Object.freeze({
  sha256,
  newUuidV7: () => uuidV7(),
  newPublicReference: publicDealReference,
});
