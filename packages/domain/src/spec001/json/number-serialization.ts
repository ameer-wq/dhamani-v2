import { decimalTextsDenoteSameValue, isStrictJsonNumberToken } from './decimal.js';

/**
 * RFC 8785 §3.2.2.3 serializes numbers with the ECMAScript `Number::toString` algorithm, which
 * emits the shortest text that round-trips to the same binary64. `String(value)` *is* that
 * algorithm, so it is the canonical form rather than an approximation of it.
 *
 * `String(-0)` is `"0"`, which is exactly the negative-zero canonicalization §11.2 requires.
 */
export function jcsSerializeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('JCS_NON_FINITE_NUMBER');
  if (Object.is(value, -0)) return '0';
  return String(value);
}

export type NumberAcceptance =
  | { accepted: true; value: number; canonical: string }
  | { accepted: false; reason: 'GRAMMAR' | 'NON_FINITE' | 'DECIMAL_VALUE_CHANGED' };

/**
 * §11.2 — a numeric token is accepted iff (1) it parses to a finite binary64, and (2) the JCS
 * serialization of that binary64 denotes the *same exact decimal value* as the original token.
 *
 * Step 2 is a decimal-text comparison (see `decimal.ts`), not a binary64 round-trip. That is what
 * makes `1e-400` reject (it underflows to `0`, changing the value) while `1.0`, `1.10` and `-0`
 * accept as pure formatting differences.
 */
export function acceptJsonNumberToken(token: string): NumberAcceptance {
  if (!isStrictJsonNumberToken(token)) return { accepted: false, reason: 'GRAMMAR' };
  const value = Number(token);
  if (!Number.isFinite(value)) return { accepted: false, reason: 'NON_FINITE' };
  const canonical = jcsSerializeNumber(value);
  if (!decimalTextsDenoteSameValue(token, canonical))
    return { accepted: false, reason: 'DECIMAL_VALUE_CHANGED' };
  return { accepted: true, value, canonical };
}
