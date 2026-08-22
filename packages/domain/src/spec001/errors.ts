/**
 * SPEC-001 §27 stable result/error contract.
 *
 * Raw PostgreSQL/driver errors are never a caller contract; every failure that leaves the
 * domain/application boundary is one of these codes.
 */
export const SPEC001_ERROR_CODES = [
  'DEAL_NOT_FOUND',
  'DEAL_TERMINATED',
  'NOT_DEAL_PARTICIPANT',
  'INVALID_DEAL_TYPE',
  'INVALID_DEAL_ROLE_PAIR',
  'SAME_PARTICIPANT_BOTH_SIDES',
  'COUNTERPARTY_NOT_BOUND',
  'COUNTERPARTY_ALREADY_BOUND',
  'PENDING_INVITE_MISMATCH',
  'INVITATION_EXPIRED',
  'WITHDRAW_NOT_ALLOWED',
  'REVISION_NOT_FOUND',
  'REVISION_NOT_CURRENT',
  'REVISION_CHANGED',
  'REVISION_ALREADY_RESPONDED',
  'REVISION_RESPONSE_CONFLICT',
  'REVISION_TERMS_UNCHANGED',
  'REVISION_SEQUENCE_CONFLICT',
  'ACTOR_MUST_WAIT_FOR_COUNTERPARTY',
  'MODIFICATION_LIMIT_REACHED',
  'UNSUPPORTED_TERMS_SCHEMA',
  'TERMS_SCHEMA_MISMATCH',
  'INVALID_TERMS_ENVELOPE',
  'TERMS_PAYLOAD_TOO_LARGE',
  'TERMS_JSON_DUPLICATE_KEY',
  'TERMS_JSON_UNSUPPORTED_UNICODE',
  'TERMS_JSON_NUMBER_OUT_OF_JCS_DOMAIN',
  'TERMS_JSON_DEPTH_EXCEEDED',
  'TERMS_JSON_NODE_LIMIT_EXCEEDED',
  'REVISION_INTEGRITY_FAILURE',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENT_REQUEST_IN_PROGRESS',
  'DEAL_WRITE_RETRYABLE',
  'VALIDATION_ERROR',
  'DEAL_REFERENCE_GENERATION_FAILED',
] as const;

export type Spec001ErrorCode = (typeof SPEC001_ERROR_CODES)[number];

/** §20 terminal reasons owned by SPEC-001. */
export const TERMINATION_REASONS = [
  'REJECTED',
  'INVITATION_WITHDRAWN',
  'NEGOTIATION_WITHDRAWN',
  'INVITATION_EXPIRED',
] as const;

export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * Structured payload carried by a typed failure. §20 requires `DEAL_TERMINATED` to expose the
 * persisted `terminationReason` so callers can distinguish all four terminal outcomes; the raw
 * enum text is not itself a localized UX contract.
 */
export type Spec001ErrorDetails = Readonly<{
  terminationReason?: TerminationReason;
  expectedRevisionId?: string;
  actualRevisionId?: string;
  field?: string;
  reason?: string;
}>;

export class Spec001Error extends Error {
  readonly code: Spec001ErrorCode;
  readonly details: Spec001ErrorDetails;

  constructor(code: Spec001ErrorCode, details: Spec001ErrorDetails = {}) {
    super(code);
    this.name = 'Spec001Error';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  /** Terminal rejections must not lose the persisted reason across boundaries. */
  static terminated(terminationReason: TerminationReason): Spec001Error {
    return new Spec001Error('DEAL_TERMINATED', { terminationReason });
  }

  toPayload(): { code: Spec001ErrorCode; details: Spec001ErrorDetails } {
    return { code: this.code, details: this.details };
  }
}

export function isSpec001Error(value: unknown): value is Spec001Error {
  return value instanceof Spec001Error;
}
