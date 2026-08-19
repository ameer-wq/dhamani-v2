import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Spec001Error } from '../../../packages/domain/src/spec001/errors.ts';
import {
  canonicalizeJsonNode,
  canonicalizeValue,
} from '../../../packages/domain/src/spec001/json/jcs.ts';
import {
  MAX_CHILD_NODES,
  MAX_DEPTH,
  parseStrictJsonText,
} from '../../../packages/domain/src/spec001/json/strict-json.ts';
import { acceptJsonNumberToken } from '../../../packages/domain/src/spec001/json/number-serialization.ts';
import { decimalTextsDenoteSameValue } from '../../../packages/domain/src/spec001/json/decimal.ts';

function canonicalOf(text: string): string {
  return canonicalizeJsonNode(parseStrictJsonText(text));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Spec001Error ? error.code : `UNEXPECTED:${String(error)}`;
  }
  return 'NO_ERROR_THROWN';
}

/**
 * Golden vectors. Both the canonical text and the digest are stated as literal constants that
 * were produced independently of this implementation (verified with `openssl dgst -sha256` and
 * `sha256sum`), so an implementation regression cannot redefine its own expectation.
 */
const GOLDEN_VECTORS: ReadonlyArray<{ input: string; canonical: string; sha256: string }> = [
  {
    input: '{"b":1,"a":"x"}',
    canonical: '{"a":"x","b":1}',
    sha256: 'cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246',
  },
  {
    // Contains a non-dyadic ordinary decimal (19.99), required by §11.4.
    input: '{"typeTerms":{"price":19.99},"common":{"title":"T"}}',
    canonical: '{"common":{"title":"T"},"typeTerms":{"price":19.99}}',
    sha256: 'ae4aa636f524f1a4d7898c911366138ce6b6a476e3016e1ff34643743c027d25',
  },
  {
    input: '[]',
    canonical: '[]',
    sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  },
];

describe('SPEC-001 §11 canonicalization and accepted JSON domain', () => {
  it('spec001_terms_fingerprint_is_jcs_sha256_deterministic', () => {
    // Published RFC 8785 Appendix B vector, exercised at the canonicalizer level. The SPEC-001
    // accepted-number domain (§11.2) is deliberately narrower than RFC 8785 and rejects
    // 333333333.33333329, so this vector proves the serializer rather than the intake gate.
    const rfcInput =
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"/",' +
      '"literals":[null,true,false]}';
    const rfcExpected =
      '{"literals":[null,true,false],' +
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$' +
      '\\u000f' +
      '\\n' +
      "A'B" +
      '\\"' +
      '\\\\' +
      '\\\\' +
      '\\"' +
      '/"}';
    expect(canonicalizeValue(JSON.parse(rfcInput))).toBe(rfcExpected);

    for (const golden of GOLDEN_VECTORS) {
      expect(canonicalOf(golden.input), `canonical of ${golden.input}`).toBe(golden.canonical);
      expect(sha256Hex(canonicalOf(golden.input)), `digest of ${golden.input}`).toBe(golden.sha256);
    }

    // Determinism: repeated canonicalization of differently-spelled equivalent inputs agrees.
    expect(sha256Hex(canonicalOf('{"a":"x","b":1}'))).toBe(
      sha256Hex(canonicalOf('{"b":1,"a":"x"}')),
    );
  });

  it('spec001_e34_jcs_key_order_and_whitespace', () => {
    const compact = canonicalOf('{"b":1,"a":2}');
    const spaced = canonicalOf('{ "a" : 2 ,\n\t "b" : 1 }');
    expect(compact).toBe('{"a":2,"b":1}');
    expect(spaced).toBe(compact);
    expect(canonicalOf('{"a":{"z":1,"y":[3,{"q":1,"p":2}]}}')).toBe(
      '{"a":{"y":[3,{"p":2,"q":1}],"z":1}}',
    );
    // Array order is data and must NOT be sorted.
    expect(canonicalOf('[3,1,2]')).toBe('[3,1,2]');
  });

  it('spec001_accepted_number_domain_matches_frozen_fixtures', () => {
    const accept: ReadonlyArray<readonly [string, string]> = [
      ['1.0', '1'],
      ['1.10', '1.1'],
      ['19.99', '19.99'],
      ['0.1', '0.1'],
      ['1.005', '1.005'],
      ['-0', '0'],
      ['1e-7', '1e-7'],
      ['1e-323', '1e-323'],
    ];
    for (const [token, canonical] of accept) {
      const result = acceptJsonNumberToken(token);
      expect(result.accepted, `${token} must be accepted`).toBe(true);
      if (result.accepted) expect(result.canonical, `${token} canonical`).toBe(canonical);
    }
    for (const token of ['1e-400', '12345678901234567890', '1e400']) {
      expect(acceptJsonNumberToken(token).accepted, `${token} must be rejected`).toBe(false);
    }

    // §11.2 forbids deciding step 2 by parsing both texts back to binary64. This asserts the
    // comparator is genuinely decimal: binary64 makes the two texts equal, exact decimals do not.
    expect(Number('1e-400')).toBe(Number('0'));
    expect(decimalTextsDenoteSameValue('1e-400', '0')).toBe(false);
    expect(decimalTextsDenoteSameValue('1.0', '1')).toBe(true);
    expect(decimalTextsDenoteSameValue('1e1', '10')).toBe(true);
    expect(decimalTextsDenoteSameValue('-0', '0')).toBe(true);
    expect(decimalTextsDenoteSameValue('1.10', '1.1')).toBe(true);
  });

  it('spec001_e35_contract_string_distinction', () => {
    // Decomposed "e + combining acute" and precomposed "e-acute" must stay distinct.
    const decomposed = 'é';
    const precomposed = 'é';
    expect(decomposed).not.toBe(precomposed);
    expect(canonicalOf('{"a":"e\\u0301","b":"\\u00e9"}')).toBe(
      `{"a":"${decomposed}","b":"${precomposed}"}`,
    );
    expect(sha256Hex(canonicalOf('{"a":"e\\u0301"}'))).not.toBe(
      sha256Hex(canonicalOf('{"a":"\\u00e9"}')),
    );
    // No trimming, case folding or rewriting of authored text.
    expect(canonicalOf('{"t":"  Padded  Value  "}')).toBe('{"t":"  Padded  Value  "}');
    expect(canonicalOf('{"t":"MiXeD"}')).toBe('{"t":"MiXeD"}');
    // A valid surrogate pair is preserved as one scalar value.
    expect(canonicalOf('{"a":"\\ud83d\\ude00"}')).toBe('{"a":"\u{1F600}"}');
  });

  it('spec001_strict_json_boundary_rejects_out_of_domain_input', () => {
    expect(codeOf(() => parseStrictJsonText('{"a":1,"a":2}'))).toBe('TERMS_JSON_DUPLICATE_KEY');
    expect(codeOf(() => parseStrictJsonText('{"o":{"x":1,"y":2,"x":3}}'))).toBe(
      'TERMS_JSON_DUPLICATE_KEY',
    );
    expect(codeOf(() => parseStrictJsonText('{"a":"x\\u0000y"}'))).toBe(
      'TERMS_JSON_UNSUPPORTED_UNICODE',
    );
    expect(codeOf(() => parseStrictJsonText('{"a":"\\ud800"}'))).toBe(
      'TERMS_JSON_UNSUPPORTED_UNICODE',
    );
    expect(codeOf(() => parseStrictJsonText('{"a":"\\udc00x"}'))).toBe(
      'TERMS_JSON_UNSUPPORTED_UNICODE',
    );
    expect(codeOf(() => parseStrictJsonText('{"a":1e-400}'))).toBe(
      'TERMS_JSON_NUMBER_OUT_OF_JCS_DOMAIN',
    );
    expect(codeOf(() => parseStrictJsonText('{"a":12345678901234567890}'))).toBe(
      'TERMS_JSON_NUMBER_OUT_OF_JCS_DOMAIN',
    );
    expect(codeOf(() => parseStrictJsonText('{"a":1,}'))).toBe('INVALID_TERMS_ENVELOPE');
    expect(codeOf(() => parseStrictJsonText('{"a":01}'))).toBe('INVALID_TERMS_ENVELOPE');
    expect(codeOf(() => parseStrictJsonText('{"a":1} trailing'))).toBe('INVALID_TERMS_ENVELOPE');

    // Plain JSON.parse silently keeps the last duplicate, which is precisely why the strict
    // reader — not JSON.parse — is the accepted-domain boundary (§11.1).
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
  });

  it('spec001_e36_terms_payload_bounds', () => {
    const atDepth = '['.repeat(MAX_DEPTH - 1) + '1' + ']'.repeat(MAX_DEPTH - 1);
    const overDepth = '['.repeat(MAX_DEPTH) + '1' + ']'.repeat(MAX_DEPTH);
    expect(() => parseStrictJsonText(atDepth)).not.toThrow();
    expect(codeOf(() => parseStrictJsonText(overDepth))).toBe('TERMS_JSON_DEPTH_EXCEEDED');

    const atNodes = `[${Array.from({ length: MAX_CHILD_NODES }, () => '1').join(',')}]`;
    const overNodes = `[${Array.from({ length: MAX_CHILD_NODES + 1 }, () => '1').join(',')}]`;
    expect(() => parseStrictJsonText(atNodes)).not.toThrow();
    expect(codeOf(() => parseStrictJsonText(overNodes))).toBe('TERMS_JSON_NODE_LIMIT_EXCEEDED');
  });
});
