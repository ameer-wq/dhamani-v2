import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Spec001Error, type Spec001ErrorCode } from '@dhamani/domain';

/**
 * PostgreSQL access for the SPEC-001 kernel.
 *
 * §23.1 fixes the authoritative configuration baseline for existing-Deal writes, and this module
 * is the single place that owns it:
 *
 *   - Prisma **interactive transaction**  -> `prisma.$transaction(fn, options)`
 *   - isolation `ReadCommitted`           -> `SPEC001_TRANSACTION_OPTIONS.isolationLevel`
 *   - `maxWait` 5000 ms                   -> `SPEC001_TRANSACTION_OPTIONS.maxWait`
 *   - transaction `timeout` 10000 ms      -> `SPEC001_TRANSACTION_OPTIONS.timeout`
 *   - `lock_timeout = '3000ms'`           -> `SET LOCAL` as the first statement in the transaction
 *
 * Prisma 7 cannot open a direct PostgreSQL connection without a driver adapter, and the official
 * adapter for a direct connection is `@prisma/adapter-pg`, which is itself implemented on
 * node-postgres. `pg` therefore appears here only as Prisma's own transport, never as a substitute
 * for the Prisma interactive transaction the Frozen SPEC requires.
 *
 * Statements PostgreSQL exposes but the Prisma query API does not — `SELECT ... FOR UPDATE`,
 * `clock_timestamp()`, `SET LOCAL`, deferred-constraint timing, BYTEA round-trips — are issued as
 * reviewed raw SQL *inside* that same compliant transaction.
 */

export const TRANSACTION_ISOLATION_LEVEL = 'ReadCommitted' as const;
export const TRANSACTION_MAX_WAIT_MS = 5000;
export const TRANSACTION_TIMEOUT_MS = 10_000;
export const LOCK_TIMEOUT_MS = 3000;

/** The frozen §23.1 interactive-transaction options. Evidence asserts these exact values. */
export const SPEC001_TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: TRANSACTION_ISOLATION_LEVEL,
  maxWait: TRANSACTION_MAX_WAIT_MS,
  timeout: TRANSACTION_TIMEOUT_MS,
});

/** The statement that applies the frozen local lock timeout inside every kernel transaction. */
export const LOCK_TIMEOUT_STATEMENT = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;

/**
 * Bounds a single in-flight statement to the same 10 s the interactive transaction allows.
 *
 * Prisma enforces its `timeout` when the transaction tries to commit (P2028), which correctly
 * prevents an over-running transaction from ever committing but does not interrupt a statement
 * already executing. This `SET LOCAL` adds that interruption at the database. It is additive
 * hardening on top of the frozen Prisma setting, never a replacement for it.
 */
export const STATEMENT_TIMEOUT_STATEMENT = `SET LOCAL statement_timeout = '${TRANSACTION_TIMEOUT_MS}ms'`;

export type QueryResult<T> = Readonly<{ rows: T[]; rowCount: number }>;

/**
 * Default row shape when a caller does not name one. Columns are `unknown` rather than `any` so
 * an unannotated read cannot silently pretend to be typed.
 */
export type QueryRow = { [column: string]: unknown };

/** Minimal SQL surface the repository and commands use, backed by the Prisma transaction client. */
export type Sql = {
  query<T = QueryRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  execute(text: string, values?: readonly unknown[]): Promise<number>;
};

type RawClient = {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

function sqlFor(client: RawClient): Sql {
  return {
    async query<T = QueryRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<T>> {
      const rows = (await client.$queryRawUnsafe(text, ...values)) as T[];
      return { rows, rowCount: rows.length };
    },
    execute(text: string, values: readonly unknown[] = []): Promise<number> {
      return client.$executeRawUnsafe(text, ...values);
    },
  };
}

/**
 * The kernel's database handle.
 *
 * `transaction()` is the only authoritative write path. `connect()` hands out a raw node-postgres
 * client and exists solely for the direct-DB adversarial evidence the Frozen SPEC requires to run
 * as the constrained runtime role — never for application commands.
 */
export class KernelDatabase {
  readonly prisma: PrismaClient;
  private readonly connectionString: string;
  private evidencePool: pg.Pool | undefined;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }

  /** §23.1 — one Prisma interactive transaction with the frozen isolation/maxWait/timeout. */
  async transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Applied first so every lock acquisition and statement in this transaction is bounded.
      await tx.$executeRawUnsafe(LOCK_TIMEOUT_STATEMENT);
      await tx.$executeRawUnsafe(STATEMENT_TIMEOUT_STATEMENT);
      return work(sqlFor(tx as unknown as RawClient));
    }, SPEC001_TRANSACTION_OPTIONS);
  }

  /** Non-transactional read, used by readiness inspection and evidence assertions. */
  query<T = QueryRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    return sqlFor(this.prisma as unknown as RawClient).query<T>(text, values);
  }

  /** Raw node-postgres client for direct-DB adversarial evidence only. */
  async connect(): Promise<pg.PoolClient> {
    this.evidencePool ??= new pg.Pool({
      connectionString: this.connectionString,
      max: 10,
      connectionTimeoutMillis: TRANSACTION_MAX_WAIT_MS,
      idleTimeoutMillis: 10_000,
    });
    return this.evidencePool.connect();
  }

  async end(): Promise<void> {
    await this.evidencePool?.end().catch(() => undefined);
    this.evidencePool = undefined;
    await this.prisma.$disconnect();
  }
}

export function createKernelDatabase(connectionString: string): KernelDatabase {
  return new KernelDatabase(connectionString);
}

/** §22.4 — a transaction that does not commit releases its idempotency claim with it. */
export async function withTransaction<T>(
  database: KernelDatabase,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  return database.transaction(work);
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

type DriverFailure = Readonly<{ sqlState?: string; constraint?: string; message?: string }>;

type AdapterCause = Readonly<{ originalCode?: unknown; originalMessage?: unknown }>;

function failureFromAdapterCause(cause: AdapterCause | undefined): DriverFailure | undefined {
  if (!cause || typeof cause.originalCode !== 'string') return undefined;
  const text = typeof cause.originalMessage === 'string' ? cause.originalMessage : '';
  const named = /constraint "([^"]+)"/.exec(text)?.[1];
  return {
    sqlState: cause.originalCode,
    ...(named ? { constraint: named } : {}),
    ...(text ? { message: text } : {}),
  };
}

/**
 * Recovers the PostgreSQL SQLSTATE and constraint name from a failure.
 *
 * Prisma wraps raw-query failures as `P2010` and carries the original driver error underneath, so
 * the real SQLSTATE has to be unwrapped rather than read off the Prisma code. Plain node-postgres
 * errors, raised by the direct-DB evidence paths, are read directly.
 *
 * A third shape exists and must be decoded too. `@prisma/adapter-pg` issues the
 * transaction-lifecycle statements — `BEGIN`, `SET TRANSACTION ISOLATION LEVEL`, savepoints and
 * the engine's `COMMIT`/`ROLLBACK` — through its own `executeRaw`, whose failures are re-thrown
 * from `PgTransaction.onError` as a bare `DriverAdapterError`. Those never pass through the query
 * pipeline that produces `P2010`, and they carry the SQLSTATE on `cause.originalCode`. Without
 * this branch a real §22.4 contention outcome (a `lock_timeout`/`statement_timeout` cancellation,
 * or a lost connection, observed while the transaction was being started, committed or rolled
 * back) escapes untyped and becomes a raw driver error at the caller contract, which §27 forbids.
 */
export function driverFailureOf(error: unknown): DriverFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    meta?: { driverAdapterError?: { cause?: AdapterCause } };
    message?: unknown;
    name?: unknown;
    cause?: unknown;
  };

  const wrapped = failureFromAdapterCause(candidate.meta?.driverAdapterError?.cause);
  if (wrapped) return wrapped;

  if (candidate.name === 'DriverAdapterError' && typeof candidate.cause === 'object') {
    const bare = failureFromAdapterCause(
      (candidate.cause ?? undefined) as AdapterCause | undefined,
    );
    if (bare) return bare;
  }

  // Some raw failures only carry the SQLSTATE in the rendered Prisma message.
  if (candidate.code === 'P2010' && typeof candidate.message === 'string') {
    const state = /Code: `([0-9A-Za-z]{5})`/.exec(candidate.message)?.[1];
    const named = /constraint "([^"]+)"/.exec(candidate.message)?.[1];
    if (state)
      return {
        sqlState: state,
        ...(named ? { constraint: named } : {}),
        message: candidate.message,
      };
  }

  if (typeof candidate.code === 'string' && /^[0-9A-Za-z]{5}$/.test(candidate.code)) {
    return {
      sqlState: candidate.code,
      ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
    };
  }
  return undefined;
}

/**
 * §22.4/§23.1 — lock waits, deadlocks, serialization failures and transaction/statement timeouts
 * are safe to retry with the same semantic command and key, so they map to one stable retryable
 * contract rather than leaking a raw driver error.
 */
const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);

function isFrozenTimeout(failure: DriverFailure): boolean {
  // 57014 is also used for an administrator/user cancellation. Only the concrete PostgreSQL
  // lock_timeout or statement_timeout forms are Frozen-authorized retryable outcomes.
  return (
    failure.sqlState === '57014' &&
    /canceling statement due to (?:lock|statement) timeout/i.test(failure.message ?? '')
  );
}

function isFrozenPrismaTransactionTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; meta?: unknown };
  if (candidate.code !== 'P2028') return false;
  const diagnostic = `${typeof candidate.message === 'string' ? candidate.message : ''} ${
    candidate.meta === undefined ? '' : JSON.stringify(candidate.meta)
  }`;
  // P2028 is a broad Transaction API error. It is retryable only when its concrete diagnostic is
  // Prisma's configured interactive-transaction timeout/expiry, never merely because of P2028.
  return /(?:transaction[^.]*timed out|timeout for this transaction|expired transaction)/i.test(
    diagnostic,
  );
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const failure = driverFailureOf(error);
  if (!failure || failure.sqlState !== '23505') return false;
  return constraint === undefined || failure.constraint === constraint;
}

export function isRetryableDatabaseError(error: unknown): boolean {
  const failure = driverFailureOf(error);
  if (failure?.sqlState && RETRYABLE_SQLSTATES.has(failure.sqlState)) return true;
  if (failure && isFrozenTimeout(failure)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  // P2034 has the exclusive Prisma meaning "transaction conflict or deadlock", both explicitly
  // authorized by §23.1. Pool acquisition failures, connection failures, 25P02 and broad P2028
  // failures are not silently widened into the Frozen retryable contract.
  return code === 'P2034' || isFrozenPrismaTransactionTimeout(error);
}

/**
 * Internal/application failure boundary for persistence faults with no Frozen domain meaning.
 *
 * This is intentionally not a new `Spec001ErrorCode`. A future transport maps it to its generic
 * internal-failure behavior; the raw Prisma/PostgreSQL diagnostic remains available only as the
 * internal `cause` and never becomes the caller-facing message or SQLSTATE contract (§27).
 */
export class Spec001PersistenceFailure extends Error {
  constructor(cause: unknown) {
    super('SPEC001_INTERNAL_PERSISTENCE_FAILURE', { cause });
    this.name = 'Spec001PersistenceFailure';
  }
}

/**
 * Constraint-specific meanings for a unique violation.
 *
 * Collapsing every 23505 into one code would misreport a duplicate revision number, a duplicate
 * bound Principal and a duplicate idempotency claim as the same thing. Each entry below is a
 * frozen §27 code, so this stays inside the stable contract rather than inventing one.
 */
const UNIQUE_VIOLATION_CODES: ReadonlyMap<string, Spec001ErrorCode> = new Map([
  ['RevisionResponse_revision_principal_key', 'REVISION_ALREADY_RESPONDED'],
  ['AgreementRevision_deal_number_key', 'REVISION_SEQUENCE_CONFLICT'],
  ['DealPartySlot_deal_principal_key', 'SAME_PARTICIPANT_BOTH_SIDES'],
  ['DealPartySlot_deal_slotKind_key', 'REVISION_RESPONSE_CONFLICT'],
  ['ApplicationIdempotencyRecord_claim_key', 'IDEMPOTENT_REQUEST_IN_PROGRESS'],
]);

/**
 * Never let a raw Prisma/PostgreSQL error become the caller contract (§27).
 *
 * A failure with no stable meaning is contained behind `Spec001PersistenceFailure` rather than
 * dressed up as a contract outcome: inventing a retryable or success-shaped answer for an unknown
 * persistence fault would hide a real defect behind a stable-looking code.
 */
export function mapDatabaseError(error: unknown): Spec001Error | Spec001PersistenceFailure {
  if (error instanceof Spec001Error) return error;
  if (isRetryableDatabaseError(error)) return new Spec001Error('DEAL_WRITE_RETRYABLE');
  const failure = driverFailureOf(error);
  if (failure?.sqlState === '23505') {
    const mapped = UNIQUE_VIOLATION_CODES.get(failure.constraint ?? '');
    // An unrecognised unique constraint must not be described as an unrelated domain conflict,
    // but its raw driver object must not escape either.
    if (!mapped) return new Spec001PersistenceFailure(error);
    return new Spec001Error(mapped, {
      ...(failure.constraint ? { field: failure.constraint } : {}),
    });
  }
  return new Spec001PersistenceFailure(error);
}

/** Exactly one authoritative wall-clock read per command (§29). */
export async function captureCommandTime(sql: Sql): Promise<Date> {
  const result = await sql.query<{ command_time: Date }>(
    'SELECT clock_timestamp() AS command_time',
  );
  const commandTime = result.rows[0]?.command_time;
  if (!commandTime) throw new Error('SPEC001_COMMAND_TIME_UNAVAILABLE');
  return commandTime;
}
