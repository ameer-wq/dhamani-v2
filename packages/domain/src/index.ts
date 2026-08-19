/** Pure bootstrap marker. It intentionally carries no product state or behavior. */
export const domainBootstrapVersion = 'SPEC-000' as const;

// SPEC-001 Deal + Agreement Kernel — pure domain. This package has no runtime dependencies and
// no infrastructure imports; hashing, ID minting and secure randomness arrive through ports.
export * from './spec001/errors.js';
export * from './spec001/deal-types.js';
export * from './spec001/ports.js';
export * from './spec001/json/decimal.js';
export * from './spec001/json/number-serialization.js';
export * from './spec001/json/strict-json.js';
export * from './spec001/json/jcs.js';
export * from './spec001/idempotency.js';
export * from './spec001/terms.js';
export * from './spec001/integrity.js';
export * from './spec001/state.js';
export * from './spec001/readiness.js';
