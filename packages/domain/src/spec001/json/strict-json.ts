import { Spec001Error } from '../errors.js';
import { acceptJsonNumberToken } from './number-serialization.js';

/** §10.3 resource bounds. Raising these later is a reviewed change and never rewrites history. */
export const MAX_DEPTH = 32;
export const MAX_CHILD_NODES = 4096;
export const MAX_RAW_BYTES = 1024 * 1024; // 1 MiB, checked before decode.
export const MAX_CANONICAL_BYTES = 64 * 1024; // 64 KiB canonical terms payload.

export type JsonObjectEntry = Readonly<{ key: string; value: JsonNode }>;

export type JsonNode =
  | Readonly<{ kind: 'null' }>
  | Readonly<{ kind: 'boolean'; value: boolean }>
  | Readonly<{ kind: 'string'; value: string }>
  | Readonly<{ kind: 'number'; canonical: string; value: number }>
  | Readonly<{ kind: 'array'; items: readonly JsonNode[] }>
  | Readonly<{ kind: 'object'; entries: readonly JsonObjectEntry[] }>;

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function invalid(reason: string): never {
  throw new Spec001Error('INVALID_TERMS_ENVELOPE', { reason });
}

/**
 * Rejects U+0000 and any unpaired surrogate. Unpaired surrogates are not Unicode scalar values,
 * so they cannot be encoded as UTF-8 and must never reach canonical bytes.
 */
function assertUnicodeScalarText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) throw new Spec001Error('TERMS_JSON_UNSUPPORTED_UNICODE', { reason: 'NUL' });
    if (unit >= HIGH_SURROGATE_START && unit <= HIGH_SURROGATE_END) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : Number.NaN;
      if (!(next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END))
        throw new Spec001Error('TERMS_JSON_UNSUPPORTED_UNICODE', { reason: 'UNPAIRED_SURROGATE' });
      index += 1;
      continue;
    }
    if (unit >= LOW_SURROGATE_START && unit <= LOW_SURROGATE_END)
      throw new Spec001Error('TERMS_JSON_UNSUPPORTED_UNICODE', { reason: 'UNPAIRED_SURROGATE' });
  }
}

/**
 * Strict recursive-descent JSON reader operating on the raw authored text.
 *
 * §11.1 requires duplicate object property names to be detected at any depth, which a plain
 * `JSON.parse()` cannot do because it silently keeps the last occurrence. Parsing to this AST
 * before any conversion to an ordinary JavaScript object is what preserves that detection, so
 * this reader — not `JSON.parse` — is the accepted-domain boundary.
 */
class StrictJsonReader {
  private index = 0;
  private childNodes = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonNode {
    this.skipWhitespace();
    const node = this.parseValue(1);
    this.skipWhitespace();
    if (this.index !== this.text.length) invalid('TRAILING_CONTENT');
    return node;
  }

  private countChild(): void {
    this.childNodes += 1;
    if (this.childNodes > MAX_CHILD_NODES) throw new Spec001Error('TERMS_JSON_NODE_LIMIT_EXCEEDED');
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      // RFC 8259 insignificant whitespace only: space, tab, LF, CR.
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.index += 1;
      else break;
    }
  }

  private expect(character: string): void {
    if (this.text.charAt(this.index) !== character) invalid('EXPECTED_TOKEN');
    this.index += 1;
  }

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_DEPTH) throw new Spec001Error('TERMS_JSON_DEPTH_EXCEEDED');
    if (this.index >= this.text.length) invalid('UNEXPECTED_END');
    const character = this.text.charAt(this.index);
    if (character === '{') return this.parseObject(depth);
    if (character === '[') return this.parseArray(depth);
    if (character === '"')
      return Object.freeze({ kind: 'string' as const, value: this.parseString() });
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return Object.freeze({ kind: 'boolean' as const, value: true });
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return Object.freeze({ kind: 'boolean' as const, value: false });
    }
    if (this.text.startsWith('null', this.index)) {
      this.index += 4;
      return Object.freeze({ kind: 'null' as const });
    }
    return this.parseNumber();
  }

  private parseObject(depth: number): JsonNode {
    this.expect('{');
    const entries: JsonObjectEntry[] = [];
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text.charAt(this.index) === '}') {
      this.index += 1;
      return Object.freeze({ kind: 'object' as const, entries: Object.freeze(entries) });
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      // Duplicate detection is the whole reason this reader exists; it is fatal at any depth.
      if (seen.has(key)) throw new Spec001Error('TERMS_JSON_DUPLICATE_KEY', { field: key });
      seen.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      const value = this.parseValue(depth + 1);
      this.countChild();
      entries.push(Object.freeze({ key, value }));
      this.skipWhitespace();
      const next = this.text.charAt(this.index);
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === '}') {
        this.index += 1;
        return Object.freeze({ kind: 'object' as const, entries: Object.freeze(entries) });
      }
      invalid('EXPECTED_COMMA_OR_BRACE');
    }
  }

  private parseArray(depth: number): JsonNode {
    this.expect('[');
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.text.charAt(this.index) === ']') {
      this.index += 1;
      return Object.freeze({ kind: 'array' as const, items: Object.freeze(items) });
    }
    for (;;) {
      this.skipWhitespace();
      const value = this.parseValue(depth + 1);
      this.countChild();
      items.push(value);
      this.skipWhitespace();
      const next = this.text.charAt(this.index);
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === ']') {
        this.index += 1;
        return Object.freeze({ kind: 'array' as const, items: Object.freeze(items) });
      }
      invalid('EXPECTED_COMMA_OR_BRACKET');
    }
  }

  private parseString(): string {
    this.expect('"');
    let result = '';
    for (;;) {
      if (this.index >= this.text.length) invalid('UNTERMINATED_STRING');
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        assertUnicodeScalarText(result);
        return result;
      }
      if (code === 0x5c) {
        this.index += 1;
        result += this.parseEscape();
        continue;
      }
      // RFC 8259 forbids raw control characters inside strings.
      if (code < 0x20) invalid('RAW_CONTROL_CHARACTER');
      result += this.text.charAt(this.index);
      this.index += 1;
    }
  }

  private parseEscape(): string {
    const escape = this.text.charAt(this.index);
    this.index += 1;
    if (escape === '"') return '"';
    if (escape === '\\') return '\\';
    if (escape === '/') return '/';
    if (escape === 'b') return '\b';
    if (escape === 'f') return '\f';
    if (escape === 'n') return '\n';
    if (escape === 'r') return '\r';
    if (escape === 't') return '\t';
    if (escape === 'u') {
      const hex = this.text.slice(this.index, this.index + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid('BAD_UNICODE_ESCAPE');
      this.index += 4;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    return invalid('BAD_ESCAPE');
  }

  private parseNumber(): JsonNode {
    const start = this.index;
    while (this.index < this.text.length && /[-+0-9eE.]/.test(this.text.charAt(this.index)))
      this.index += 1;
    const token = this.text.slice(start, this.index);
    if (token.length === 0) invalid('UNEXPECTED_TOKEN');
    const acceptance = acceptJsonNumberToken(token);
    if (!acceptance.accepted) {
      // A token that violates the JSON grammar itself is an envelope error; a well-formed token
      // whose value cannot survive JCS is the §11.2 accepted-domain rejection.
      if (acceptance.reason === 'GRAMMAR') invalid('BAD_NUMBER_TOKEN');
      throw new Spec001Error('TERMS_JSON_NUMBER_OUT_OF_JCS_DOMAIN', { reason: token });
    }
    return Object.freeze({
      kind: 'number' as const,
      canonical: acceptance.canonical,
      value: acceptance.value,
    });
  }
}

/** §22.2 step 0 — the raw byte cap is applied before any decode work happens. */
export function assertRawTermsWithinCap(raw: Uint8Array): void {
  if (raw.byteLength > MAX_RAW_BYTES) throw new Spec001Error('TERMS_PAYLOAD_TOO_LARGE');
}

export function parseStrictJsonText(text: string): JsonNode {
  return new StrictJsonReader(text).parseDocument();
}

/** Converts the accepted AST into ordinary JavaScript data, after all strict checks have run. */
export function jsonNodeToValue(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null':
      return null;
    case 'boolean':
      return node.value;
    case 'string':
      return node.value;
    case 'number':
      return node.value;
    case 'array':
      return node.items.map(jsonNodeToValue);
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const entry of node.entries) result[entry.key] = jsonNodeToValue(entry.value);
      return result;
    }
  }
}
