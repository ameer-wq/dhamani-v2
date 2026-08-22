/**
 * Exact decimal value of a JSON number token, kept as a normalized scaled integer.
 *
 * §11.2 step 2 compares the exact decimal values denoted by two number texts and explicitly
 * MUST NOT parse both texts back to binary64 — doing so would make the comparison vacuous
 * (every candidate would trivially compare equal). This module is therefore the authoritative
 * comparator and never calls `Number()` on the texts it compares.
 */
export type ExactDecimal = Readonly<{
  /** `true` when the value is exactly zero; sign is then irrelevant (`-0` denotes `0`). */
  isZero: boolean;
  negative: boolean;
  /** Significand with all trailing zeros removed, so the representation is canonical. */
  digits: bigint;
  /** Value is `sign * digits * 10 ** exponent`. */
  exponent: number;
}>;

/** Strict RFC 8259 number grammar: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`. */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

export function isStrictJsonNumberToken(token: string): boolean {
  return JSON_NUMBER.test(token);
}

/**
 * Parses a JSON number token into its exact decimal value. Returns `undefined` when the token
 * is not a strict JSON number. No precision is lost: the significand is a BigInt.
 */
export function exactDecimalOf(token: string): ExactDecimal | undefined {
  if (!isStrictJsonNumberToken(token)) return undefined;
  const negative = token.startsWith('-');
  const unsigned = negative ? token.slice(1) : token;
  const exponentSplit = unsigned.split(/[eE]/);
  const mantissaText = exponentSplit[0] ?? '';
  const exponentText = exponentSplit[1];
  const explicitExponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);
  const [integerPart = '', fractionPart = ''] = mantissaText.split('.');
  const digitsText = `${integerPart}${fractionPart}`;
  let digits = BigInt(digitsText);
  let exponent = explicitExponent - fractionPart.length;
  if (digits === 0n)
    return Object.freeze({ isZero: true, negative: false, digits: 0n, exponent: 0 });
  // Normalize so that equal values always share one representation (e.g. `1e1` and `10`).
  while (digits % 10n === 0n) {
    digits /= 10n;
    exponent += 1;
  }
  return Object.freeze({ isZero: false, negative, digits, exponent });
}

/** Exact decimal-value equality of two number texts. Never re-parses either text to binary64. */
export function decimalTextsDenoteSameValue(left: string, right: string): boolean {
  const a = exactDecimalOf(left);
  const b = exactDecimalOf(right);
  if (a === undefined || b === undefined) return false;
  if (a.isZero || b.isZero) return a.isZero && b.isZero;
  return a.negative === b.negative && a.digits === b.digits && a.exponent === b.exponent;
}
