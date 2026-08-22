import type { JsonNode } from './strict-json.js';
import { jcsSerializeNumber } from './number-serialization.js';

/**
 * RFC 8785 (JCS) canonicalization over the accepted-domain AST.
 *
 * Canonicalizing the AST rather than a re-parsed JavaScript object keeps the already-validated
 * number texts and preserves authored string code points exactly (§11.1: no normalization,
 * trimming, case-folding or rewriting is ever applied).
 */

const ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x22, '\\"'],
  [0x5c, '\\\\'],
]);

/**
 * RFC 8785 §3.2.2.2 string production: escape only the two mandatory characters and the C0
 * controls, using the short forms where they exist and lowercase `\u00xx` otherwise.
 */
export function jcsSerializeString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const shortEscape = ESCAPES.get(code);
    if (shortEscape !== undefined) {
      out += shortEscape;
      continue;
    }
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += value.charAt(index);
  }
  return `${out}"`;
}

/**
 * RFC 8785 §3.2.3 sorts object property names by their UTF-16 code unit sequences. JavaScript's
 * default string relational comparison is exactly UTF-16 code unit order, so it is the sort key
 * rather than a locale-aware or code-point comparison.
 */
function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function canonicalizeJsonNode(node: JsonNode): string {
  switch (node.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'string':
      return jcsSerializeString(node.value);
    case 'number':
      return node.canonical;
    case 'array':
      return `[${node.items.map(canonicalizeJsonNode).join(',')}]`;
    case 'object': {
      const sorted = [...node.entries].sort((left, right) => compareKeys(left.key, right.key));
      const members = sorted.map(
        (entry) => `${jcsSerializeString(entry.key)}:${canonicalizeJsonNode(entry.value)}`,
      );
      return `{${members.join(',')}}`;
    }
  }
}

/**
 * Canonicalizes ordinary JavaScript data. Used only for values the kernel itself constructs
 * (integrity pre-images, idempotency fingerprints), never for re-deriving accepted terms bytes.
 */
export function canonicalizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return jcsSerializeNumber(value);
  if (typeof value === 'string') return jcsSerializeString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, member]) => member !== undefined,
    );
    entries.sort(([left], [right]) => compareKeys(left, right));
    return `{${entries
      .map(([key, member]) => `${jcsSerializeString(key)}:${canonicalizeValue(member)}`)
      .join(',')}}`;
  }
  throw new Error('JCS_UNSUPPORTED_VALUE');
}
