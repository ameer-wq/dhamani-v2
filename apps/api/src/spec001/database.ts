import pg from 'pg';
import { Spec001Error, type Spec001ErrorCode } from '@dhamani/domain';

/**
 * PostgreSQL access for the SPEC-001 kernel.
 *
 * Raw `pg` is used rather than Prisma Client for the runtime data path because SPEC-001 depends
 * on primitives Prisma does not expose faithfully: an explicit READ COMMITTED transaction, a
 * mandatory `SELECT ... FOR UPDATE` Deal row lock, exactly one `clock_timestamp()` read after
 * that lock, deferred-constraint timing, BYTEA round-tripping without re-encoding, per-role
 * connections for least-privilege evidence, and SQLSTATE-accurate error mapping. Prisma remains
 * the migration authority (§24.2), which is where the frozen migration policy applies.
 *
 * §23.1 configuration baseline, expressed as the evidence-proven equivalent of the Prisma
 * settings named in the SPEC:
 *   - isolation: READ COMMITTED           -> BEGIN ISOLATION LEVEL READ COMMITTED
 *   - lock_timeout: 3000 ms               -> SET LOCAL lock_timeout
 *   - transaction timeout: 10000 ms       -> SET LOCAL statement_timeout
 *   - maxWait 5000 ms (pool acquisition)  -> Pool connectionTimeoutMillis
 */

export const LOCK_TIMEOUT_MS = 3000;
export const TRANSACTION_TIMEOUT_MS = 10_000;
export const POOL_ACQUIRE_TIMEOUT_MS = 5000;

export type Sql = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
  });
}

type PostgresError = { code?: string; constraint?: string; message?: string };

function postgresErrorOf(error: unknown): PostgresError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as PostgresError;
  return typeof candidate.code === 'string' ? candidate : undefined;
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
  '57014', // query_canceled (statement_timeout / lock_timeout)
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const postgres = postgresErrorOf(error);
  if (!postgres || postgres.code !== '23505') return false;
  return constraint === undefined || postgres.constraint === constraint;
}

export function isRetryableDatabaseError(error: unknown): boolean {
  const postgres = postgresErrorOf(error);
  return postgres !== undefined && RETRYABLE_SQLSTATES.has(postgres.code ?? '');
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
 * A SQLSTATE with no stable meaning is deliberately re-thrown rather than dressed up as a
 * contract outcome: inventing a success-shaped or retryable answer for an unknown persistence
 * fault would hide a real defect behind a stable-looking code.
 */
export function mapDatabaseError(error: unknown): Spec001Error {
  if (error instanceof Spec001Error) return error;
  if (isRetryableDatabaseError(error)) return new Spec001Error('DEAL_WRITE_RETRYABLE');
  const postgres = postgresErrorOf(error);
  if (postgres?.code === '23505') {
    const mapped = UNIQUE_VIOLATION_CODES.get(postgres.constraint ?? '');
    return new Spec001Error(mapped ?? 'REVISION_RESPONSE_CONFLICT', {
      ...(postgres.constraint ? { field: postgres.constraint } : {}),
    });
  }
  throw error;
}

/**
 * Runs `work` inside one explicit READ COMMITTED transaction with the SPEC-001 timeouts applied
 * as session-local settings, so they cannot leak to another pooled user of the connection.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${TRANSACTION_TIMEOUT_MS}ms'`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A transaction that does not commit releases its idempotency claim with it (§22.4).
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
