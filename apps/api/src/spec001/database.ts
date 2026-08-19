import pg from 'pg';
import { Spec001Error } from '@dhamani/domain';

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

/** Never let a raw Prisma/PostgreSQL error become the caller contract (§27). */
export function mapDatabaseError(error: unknown): Spec001Error {
  if (error instanceof Spec001Error) return error;
  if (isRetryableDatabaseError(error)) return new Spec001Error('DEAL_WRITE_RETRYABLE');
  const postgres = postgresErrorOf(error);
  if (postgres?.code === '23505') return new Spec001Error('REVISION_RESPONSE_CONFLICT');
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

export type LockedDeal = Readonly<{
  id: string;
  publicReference: string;
  dealType: string;
  currentRevisionId: string;
  sentAt: Date;
  inviteExpiresAt: Date;
  firstMutualAcceptedAt: Date | null;
  terminationReason: string | null;
  terminatedAt: Date | null;
  version: number;
  createdAt: Date;
}>;

/**
 * §23.1 steps 2–3: acquire the mandatory Deal row lock, then capture exactly one PostgreSQL
 * `clock_timestamp()`.
 *
 * The clock is read *after* the lock on purpose (§29): `now()`/`transaction_timestamp()` are
 * fixed at transaction start and would predate any lock wait, so a command that waited would
 * evaluate deadlines against a stale instant.
 */
export async function lockDealAndCaptureCommandTime(
  sql: Sql,
  dealId: string,
): Promise<{ deal: LockedDeal | undefined; commandTime: Date }> {
  const locked = await sql.query<LockedDeal>(
    `SELECT "id","publicReference","dealType"::text AS "dealType","currentRevisionId","sentAt",
            "inviteExpiresAt","firstMutualAcceptedAt","terminationReason"::text AS "terminationReason",
            "terminatedAt","version","createdAt"
       FROM "Deal" WHERE "id" = $1 FOR UPDATE`,
    [dealId],
  );
  const commandTime = await captureCommandTime(sql);
  return { deal: locked.rows[0], commandTime };
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
