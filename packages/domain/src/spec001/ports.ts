/**
 * Capability ports.
 *
 * The domain package is pure TypeScript with no infrastructure imports, so hashing, ID minting
 * and secure randomness are injected rather than imported. This also lets evidence force
 * deterministic collisions and exhaustion (§6.2) without a production back door.
 */

/** SHA-256 over exact bytes, returning the 32-byte digest. */
export type Sha256 = (input: Uint8Array) => Uint8Array;

/**
 * Mints a server-side UUIDv7 in canonical lowercase hyphenated text. §6.1 forbids caller-supplied
 * IDs for new SPEC-001 entities and forbids DB-side random UUID defaults.
 */
export type UuidV7Generator = () => string;

/** Generates a `DH-XXXX-XXXX-XXXX` public reference from cryptographically secure random bytes. */
export type PublicReferenceGenerator = () => string;

export type KernelPorts = Readonly<{
  sha256: Sha256;
  newUuidV7: UuidV7Generator;
  newPublicReference: PublicReferenceGenerator;
}>;
