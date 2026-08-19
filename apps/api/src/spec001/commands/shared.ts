import type pg from 'pg';
import {
  Spec001Error,
  isEffectivelyExpired,
  isTerminal,
  type DealSnapshot,
  type KernelPorts,
  type Spec001ErrorCode,
  type TerminationReason,
} from '@dhamani/domain';
import { captureCommandTime, mapDatabaseError, withTransaction, type Sql } from '../database.js';
import { claimIdempotency, settleIdempotency } from '../idempotency-store.js';
import {
  appendAuditEvent,
  loadDealSnapshot,
  lockDeal,
  updateDeal,
  type LockedDealRow,
} from '../repository.js';

export type CommandContext = Readonly<{
  sql: Sql;
  ports: KernelPorts;
  commandTime: Date;
  snapshot: DealSnapshot;
  dealRow: LockedDealRow;
  actorScope: string;
  correlationId: string;
}>;

export type CommandOutcome<T> = Readonly<{
  /** Value returned to the caller. */
  result: T;
  /** Immutable commit-time facts stored for replay (§22.5). Never live-derived projections. */
  storedFacts: Record<string, unknown>;
}>;

export type KeyedDealCommandRequest<T> = Readonly<{
  commandType: string;
  scope: string;
  idempotencyKey: string;
  fingerprint: Uint8Array;
  dealId: string;
  correlationId: string;
  actorScope: string;
  execute: (context: CommandContext) => Promise<CommandOutcome<T>>;
  replay: (storedFacts: Record<string, unknown>) => T;
}>;

type TransactionVerdict<T> =
  | Readonly<{ kind: 'RESULT'; value: T }>
  /** Committed an authoritative transition and must still report a typed failure (§23.3 step 6). */
  | Readonly<{ kind: 'COMMITTED_TYPED_ERROR'; code: Spec001ErrorCode; details: object }>;

function storedTypedError(storedFacts: Record<string, unknown>): Spec001Error | undefined {
  const code = storedFacts.typedErrorCode;
  if (typeof code !== 'string') return undefined;
  const details = (storedFacts.typedErrorDetails ?? {}) as Record<string, unknown>;
  return new Spec001Error(code as Spec001ErrorCode, details);
}

/**
 * The uniform keyed existing-Deal command pipeline, implementing the §23.3 authoritative
 * precondition precedence:
 *
 *   1. committed idempotency replay / key-payload conflict / unresolved claim
 *   2. Deal existence
 *   3. Deal row lock
 *   4. capture commandTime and authoritative reads
 *   5. already-materialized terminal state -> DEAL_TERMINATED + structured terminationReason
 *   6. effective expiry -> latch INVITATION_EXPIRED (the one precondition whose failure commits
 *      an authoritative transition)
 *   7+. command-specific preconditions, supplied by `execute`
 *
 * The claim is taken before the Deal row lock (§23.1) so no keyed command can invert that order
 * and create a lock cycle.
 */
export async function runKeyedDealCommand<T>(
  pool: pg.Pool,
  ports: KernelPorts,
  request: KeyedDealCommandRequest<T>,
): Promise<T> {
  let verdict: TransactionVerdict<T>;
  try {
    verdict = await withTransaction(pool, async (sql): Promise<TransactionVerdict<T>> => {
      const claim = await claimIdempotency(sql, {
        recordId: ports.newUuidV7(),
        scope: request.scope,
        commandType: request.commandType,
        idempotencyKey: request.idempotencyKey,
        fingerprint: request.fingerprint,
      });
      if (claim.status === 'REPLAY') {
        const typed = storedTypedError(claim.stored.outcome);
        // A replayed deterministic typed error is re-reported as that same typed error, and
        // re-materializes nothing (§9.1, §22.5).
        if (typed)
          return { kind: 'COMMITTED_TYPED_ERROR', code: typed.code, details: typed.details };
        return { kind: 'RESULT', value: request.replay(claim.stored.outcome) };
      }

      const dealRow = await lockDeal(sql, request.dealId);
      if (!dealRow) throw new Spec001Error('DEAL_NOT_FOUND');

      // §29 — exactly one clock_timestamp(), read after the lock so a lock wait cannot leave the
      // command reasoning about a stale instant.
      const commandTime = await captureCommandTime(sql);
      const snapshot = await loadDealSnapshot(sql, dealRow);

      if (isTerminal(snapshot.deal)) {
        const reason = snapshot.deal.terminationReason as TerminationReason;
        throw Spec001Error.terminated(reason);
      }

      if (isEffectivelyExpired(snapshot.deal, commandTime)) {
        await latchInvitationExpiry(sql, ports, {
          dealRow,
          commandTime,
          correlationId: request.correlationId,
          actorScope: request.actorScope,
        });
        await settleIdempotency(sql, claim.recordId, 'TYPED_ERROR', commandTime, {
          typedErrorCode: 'INVITATION_EXPIRED',
          typedErrorDetails: { terminationReason: 'INVITATION_EXPIRED' },
        });
        return {
          kind: 'COMMITTED_TYPED_ERROR',
          code: 'INVITATION_EXPIRED',
          details: { terminationReason: 'INVITATION_EXPIRED' },
        };
      }

      const outcome = await request.execute({
        sql,
        ports,
        commandTime,
        snapshot,
        dealRow,
        actorScope: request.actorScope,
        correlationId: request.correlationId,
      });
      await settleIdempotency(sql, claim.recordId, 'SUCCESS', commandTime, outcome.storedFacts);
      return { kind: 'RESULT', value: outcome.result };
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }
  if (verdict.kind === 'COMMITTED_TYPED_ERROR')
    throw new Spec001Error(verdict.code, verdict.details);
  return verdict.value;
}

/**
 * §9.1 — expiry latching on first observation. The transaction materializes terminal expiry
 * before refusing the caller's requested action, so the terminal state is a real committed fact
 * rather than something re-derived on every later read.
 */
export async function latchInvitationExpiry(
  sql: Sql,
  ports: KernelPorts,
  input: {
    dealRow: LockedDealRow;
    commandTime: Date;
    correlationId: string;
    actorScope: string;
  },
): Promise<number> {
  const version = await updateDeal(sql, input.dealRow.id, input.dealRow.version, {
    terminationReason: 'INVITATION_EXPIRED',
    terminatedAt: input.commandTime,
  });
  await appendAuditEvent(sql, ports, {
    dealId: input.dealRow.id,
    eventType: 'INVITATION_EXPIRED',
    actorScope: input.actorScope,
    targetRevisionId: input.dealRow.currentRevisionId,
    commandTime: input.commandTime,
    dealVersion: version,
    correlationId: input.correlationId,
    metadata: { terminationReason: 'INVITATION_EXPIRED' },
  });
  return version;
}
