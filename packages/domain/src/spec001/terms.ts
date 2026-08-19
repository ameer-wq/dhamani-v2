import { Spec001Error } from './errors.js';
import type { DealType } from './deal-types.js';
import { canonicalizeJsonNode } from './json/jcs.js';
import {
  MAX_CANONICAL_BYTES,
  type JsonNode,
  type JsonObjectEntry,
  parseStrictJsonText,
} from './json/strict-json.js';

/**
 * §10.1 — the top-level terms structure is closed. Unknown top-level keys fail validation, which
 * is also what makes authority smuggling at the top level impossible (§10.4): an authority-looking
 * key such as `currentRevisionId` is simply not an accepted top-level member.
 */
const ALLOWED_TOP_LEVEL_KEYS = new Set(['common', 'typeTerms']);
const ALLOWED_COMMON_KEYS = new Set(['title', 'description']);

export const TITLE_MIN_CODE_POINTS = 3;
export const TITLE_MAX_CODE_POINTS = 120;
export const DESCRIPTION_MAX_CODE_POINTS = 4000;

function codePointLength(value: string): number {
  return [...value].length;
}

function nonWhitespaceCodePointLength(value: string): number {
  return [...value].filter((character) => character.trim().length > 0).length;
}

function entryOf(node: JsonNode, key: string): JsonObjectEntry | undefined {
  if (node.kind !== 'object') return undefined;
  return node.entries.find((entry) => entry.key === key);
}

export type ValidatedTerms = Readonly<{
  node: JsonNode;
  canonicalText: string;
  canonicalBytes: Uint8Array;
  title: string;
  description: string | undefined;
}>;

/**
 * §10.2 — the registry proves the schema exists, belongs to the Deal type, and that
 * type-specific validation passes. There is deliberately no permissive production fallback: an
 * unknown schema id fails closed rather than being accepted as free-form business data.
 *
 * SPEC-001 pins one schema per V1 type. Vertical field semantics are frozen in later specs, so
 * the type-specific validator here proves structure only and asserts no vertical behavior.
 */
export type TermsSchemaDefinition = Readonly<{
  termsSchemaId: string;
  dealType: DealType;
  validateTypeTerms: (typeTerms: JsonNode) => void;
}>;

function requireObject(node: JsonNode, code: 'INVALID_TERMS_ENVELOPE', reason: string): void {
  if (node.kind !== 'object') throw new Spec001Error(code, { reason });
}

const SCHEMAS: ReadonlyMap<string, TermsSchemaDefinition> = new Map(
  (
    [
      ['dhamani.goods.v1', 'GOODS'],
      ['dhamani.services.v1', 'SERVICES'],
      ['dhamani.booking.v1', 'BOOKING'],
      ['dhamani.subscription.v1', 'SUBSCRIPTION'],
      ['dhamani.digital_asset.v1', 'DIGITAL_ASSET'],
    ] as ReadonlyArray<readonly [string, DealType]>
  ).map(([termsSchemaId, dealType]) => [
    termsSchemaId,
    Object.freeze({
      termsSchemaId,
      dealType,
      validateTypeTerms: (typeTerms: JsonNode): void => {
        requireObject(typeTerms, 'INVALID_TERMS_ENVELOPE', 'TYPE_TERMS_MUST_BE_OBJECT');
      },
    }),
  ]),
);

export function termsSchemaIds(): readonly string[] {
  return [...SCHEMAS.keys()].sort();
}

export function findTermsSchema(termsSchemaId: unknown): TermsSchemaDefinition | undefined {
  if (typeof termsSchemaId !== 'string') return undefined;
  return SCHEMAS.get(termsSchemaId);
}

/**
 * Resolves a schema for a Deal type, failing closed on an unknown id and distinguishing the
 * "known schema, wrong type" case, which E37 requires to be separable.
 */
export function resolveTermsSchema(
  termsSchemaId: unknown,
  dealType: DealType,
): TermsSchemaDefinition {
  const schema = findTermsSchema(termsSchemaId);
  if (!schema) throw new Spec001Error('UNSUPPORTED_TERMS_SCHEMA');
  if (schema.dealType !== dealType) throw new Spec001Error('TERMS_SCHEMA_MISMATCH');
  return schema;
}

/**
 * Validates the decoded terms envelope and returns its canonical bytes.
 *
 * The accepted persisted string is exactly the authored string: validation may inspect
 * whitespace, but never trims, normalizes, case-folds, translates or otherwise rewrites it
 * (§5.2). Length limits are counted in Unicode code points, not UTF-16 units.
 */
export function validateTermsEnvelope(
  node: JsonNode,
  schema: TermsSchemaDefinition,
): ValidatedTerms {
  if (node.kind !== 'object')
    throw new Spec001Error('INVALID_TERMS_ENVELOPE', { reason: 'ROOT_MUST_BE_OBJECT' });

  for (const entry of node.entries)
    if (!ALLOWED_TOP_LEVEL_KEYS.has(entry.key))
      throw new Spec001Error('INVALID_TERMS_ENVELOPE', { field: entry.key, reason: 'UNKNOWN_KEY' });

  const commonEntry = entryOf(node, 'common');
  const typeTermsEntry = entryOf(node, 'typeTerms');
  if (!commonEntry)
    throw new Spec001Error('INVALID_TERMS_ENVELOPE', { field: 'common', reason: 'REQUIRED' });
  if (!typeTermsEntry)
    throw new Spec001Error('INVALID_TERMS_ENVELOPE', { field: 'typeTerms', reason: 'REQUIRED' });

  const common = commonEntry.value;
  requireObject(common, 'INVALID_TERMS_ENVELOPE', 'COMMON_MUST_BE_OBJECT');
  if (common.kind !== 'object') throw new Spec001Error('INVALID_TERMS_ENVELOPE');

  for (const entry of common.entries)
    if (!ALLOWED_COMMON_KEYS.has(entry.key))
      throw new Spec001Error('INVALID_TERMS_ENVELOPE', {
        field: `common.${entry.key}`,
        reason: 'UNKNOWN_KEY',
      });

  const titleEntry = entryOf(common, 'title');
  if (!titleEntry || titleEntry.value.kind !== 'string')
    throw new Spec001Error('VALIDATION_ERROR', {
      field: 'common.title',
      reason: 'REQUIRED_STRING',
    });
  const title = titleEntry.value.value;
  const titleLength = codePointLength(title);
  if (titleLength < TITLE_MIN_CODE_POINTS || titleLength > TITLE_MAX_CODE_POINTS)
    throw new Spec001Error('VALIDATION_ERROR', { field: 'common.title', reason: 'LENGTH' });
  if (nonWhitespaceCodePointLength(title) < TITLE_MIN_CODE_POINTS)
    throw new Spec001Error('VALIDATION_ERROR', {
      field: 'common.title',
      reason: 'INSUFFICIENT_NON_WHITESPACE',
    });

  const descriptionEntry = entryOf(common, 'description');
  let description: string | undefined;
  if (descriptionEntry) {
    if (descriptionEntry.value.kind !== 'string')
      throw new Spec001Error('VALIDATION_ERROR', {
        field: 'common.description',
        reason: 'MUST_BE_STRING',
      });
    description = descriptionEntry.value.value;
    if (codePointLength(description) > DESCRIPTION_MAX_CODE_POINTS)
      throw new Spec001Error('VALIDATION_ERROR', { field: 'common.description', reason: 'LENGTH' });
  }

  schema.validateTypeTerms(typeTermsEntry.value);

  const canonicalText = canonicalizeJsonNode(node);
  const canonicalBytes = new TextEncoder().encode(canonicalText);
  // §10.3 — the canonical cap is checked after canonicalization, since escape-heavy input can
  // shrink. The 1 MiB raw cap was already applied before decode.
  if (canonicalBytes.byteLength > MAX_CANONICAL_BYTES)
    throw new Spec001Error('TERMS_PAYLOAD_TOO_LARGE');

  return Object.freeze({
    node,
    canonicalText,
    canonicalBytes,
    title,
    ...(description === undefined ? {} : { description }),
  }) as ValidatedTerms;
}

/** Convenience for callers holding raw authored text that already passed the raw byte cap. */
export function parseAndValidateTerms(
  rawText: string,
  schema: TermsSchemaDefinition,
): ValidatedTerms {
  return validateTermsEnvelope(parseStrictJsonText(rawText), schema);
}
