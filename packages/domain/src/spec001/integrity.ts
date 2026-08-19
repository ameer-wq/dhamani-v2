import { Spec001Error } from './errors.js';
import type { DealType } from './deal-types.js';
import { jcsSerializeString } from './json/jcs.js';
import { canonicalizeJsonNode } from './json/jcs.js';
import { parseStrictJsonText } from './json/strict-json.js';
import type { Sha256 } from './ports.js';

/** Canonical lowercase hyphenated UUID text (§11.3). */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

export function requireCanonicalUuid(value: unknown, field: string): string {
  if (!isCanonicalUuid(value))
    throw new Spec001Error('VALIDATION_ERROR', { field, reason: 'NOT_CANONICAL_UUID' });
  return value;
}

export type IntegrityPreimageInput = Readonly<{
  dealId: string;
  dealType: DealType;
  predecessorRevisionId: string | null;
  revisionNumber: number;
  /** Canonical RFC 8785 text of the validated terms payload. */
  termsPayloadCanonicalText: string;
  termsSchemaId: string;
}>;

/**
 * §11.3 — the normative integrity pre-image. It contains exactly six members with exactly these
 * key names and casing, ordered by JCS.
 *
 * `termsPayload` is embedded as the already-canonical JSON value, never as a quoted JSON string,
 * so the pre-image contains the terms structurally. R1 always carries an explicit
 * `predecessorRevisionId: null` rather than omitting the key.
 */
export function buildIntegrityPreimageText(input: IntegrityPreimageInput): string {
  requireCanonicalUuid(input.dealId, 'dealId');
  if (input.predecessorRevisionId !== null)
    requireCanonicalUuid(input.predecessorRevisionId, 'predecessorRevisionId');
  if (
    !Number.isSafeInteger(input.revisionNumber) ||
    input.revisionNumber < 1 ||
    Object.is(input.revisionNumber, -0)
  )
    throw new Spec001Error('VALIDATION_ERROR', { field: 'revisionNumber', reason: 'NOT_POSITIVE' });

  // Members are composed with pre-serialized values (termsPayload is already canonical text) and
  // then ordered by the same UTF-16 key ordering JCS mandates, so the ordering rule is applied
  // rather than assumed from the literal order written here.
  const members: ReadonlyArray<readonly [string, string]> = [
    ['dealId', jcsSerializeString(input.dealId)],
    ['dealType', jcsSerializeString(input.dealType)],
    [
      'predecessorRevisionId',
      input.predecessorRevisionId === null
        ? 'null'
        : jcsSerializeString(input.predecessorRevisionId),
    ],
    ['revisionNumber', String(input.revisionNumber)],
    ['termsPayload', input.termsPayloadCanonicalText],
    ['termsSchemaId', jcsSerializeString(input.termsSchemaId)],
  ];
  const ordered = [...members].sort(([left], [right]) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
  return `{${ordered.map(([key, value]) => `${jcsSerializeString(key)}:${value}`).join(',')}}`;
}

export type RevisionIntegrityMaterial = Readonly<{
  preimageCanonicalBytes: Uint8Array;
  integrityFingerprint: Uint8Array;
}>;

export function computeRevisionIntegrity(
  input: IntegrityPreimageInput,
  sha256: Sha256,
): RevisionIntegrityMaterial {
  const preimageCanonicalBytes = new TextEncoder().encode(buildIntegrityPreimageText(input));
  return Object.freeze({
    preimageCanonicalBytes,
    integrityFingerprint: sha256(preimageCanonicalBytes),
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export type PersistedRevisionForVerification = Readonly<{
  dealId: string;
  dealType: DealType;
  revisionNumber: number;
  predecessorRevisionId: string | null;
  termsSchemaId: string;
  termsPayloadCanonicalBytes: Uint8Array;
  integrityPreimageCanonicalBytes: Uint8Array;
  integrityFingerprint: Uint8Array;
}>;

/**
 * §11.3 verification after persistence, in the mandated order:
 *   1. SHA-256 the stored exact pre-image bytes and compare to the stored fingerprint;
 *   2. decode the pre-image through the same strict accepted-domain decoder;
 *   3. verify Deal/revision metadata matches the immutable relational columns;
 *   4. verify the embedded terms canonicalize byte-identically to the stored terms bytes.
 *
 * Integrity is never reconstructed from a JSON/JSONB projection.
 */
export function verifyRevisionIntegrity(
  revision: PersistedRevisionForVerification,
  sha256: Sha256,
): void {
  const fail = (reason: string): never => {
    throw new Spec001Error('REVISION_INTEGRITY_FAILURE', { reason });
  };

  if (!bytesEqual(sha256(revision.integrityPreimageCanonicalBytes), revision.integrityFingerprint))
    fail('FINGERPRINT_MISMATCH');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let preimageNode;
  try {
    preimageNode = parseStrictJsonText(decoder.decode(revision.integrityPreimageCanonicalBytes));
  } catch {
    return fail('PREIMAGE_NOT_IN_ACCEPTED_DOMAIN');
  }
  if (preimageNode.kind !== 'object') return fail('PREIMAGE_NOT_OBJECT');

  const member = (key: string) => preimageNode.entries.find((entry) => entry.key === key)?.value;
  const dealId = member('dealId');
  const dealType = member('dealType');
  const revisionNumber = member('revisionNumber');
  const predecessor = member('predecessorRevisionId');
  const termsSchemaId = member('termsSchemaId');
  const termsPayload = member('termsPayload');
  if (!dealId || !dealType || !revisionNumber || !predecessor || !termsSchemaId || !termsPayload)
    return fail('PREIMAGE_SHAPE');

  if (dealId.kind !== 'string' || dealId.value !== revision.dealId) fail('DEAL_ID_MISMATCH');
  if (dealType.kind !== 'string' || dealType.value !== revision.dealType)
    fail('DEAL_TYPE_MISMATCH');
  if (revisionNumber.kind !== 'number' || revisionNumber.value !== revision.revisionNumber)
    fail('REVISION_NUMBER_MISMATCH');
  if (termsSchemaId.kind !== 'string' || termsSchemaId.value !== revision.termsSchemaId)
    fail('TERMS_SCHEMA_MISMATCH');
  const expectedPredecessor = revision.predecessorRevisionId;
  if (expectedPredecessor === null) {
    if (predecessor.kind !== 'null') fail('PREDECESSOR_MISMATCH');
  } else if (predecessor.kind !== 'string' || predecessor.value !== expectedPredecessor) {
    fail('PREDECESSOR_MISMATCH');
  }

  const embeddedCanonical = new TextEncoder().encode(canonicalizeJsonNode(termsPayload));
  if (!bytesEqual(embeddedCanonical, revision.termsPayloadCanonicalBytes))
    fail('TERMS_BYTES_MISMATCH');
}

/**
 * §17.1 — the unchanged-terms comparison. It compares canonical equality of the
 * `(termsPayload, termsSchemaId)` pair only, and never the whole integrity fingerprint (which
 * also covers revision number and predecessor and would therefore never collide).
 */
export function termsComparisonCanonicalText(
  termsPayloadCanonicalText: string,
  termsSchemaId: string,
): string {
  return `{${jcsSerializeString('termsPayload')}:${termsPayloadCanonicalText},${jcsSerializeString(
    'termsSchemaId',
  )}:${jcsSerializeString(termsSchemaId)}}`;
}
