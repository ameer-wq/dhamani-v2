import type pg from 'pg';
import {
  Spec001Error,
  isEffectivelyExpired,
  isTerminal,
  requireCanonicalUuid,
  type KernelPorts,
} from '@dhamani/domain';
import { captureCommandTime, mapDatabaseError, withTransaction } from '../database.js';
import { lockDeal, toDealState } from '../repository.js';
import { latchInvitationExpiry } from './shared.js';

export type ExpireInvitationIfDueInput = Readonly<{
  /** Trusted system/application scope. This command has no participant actor. */
  actorScope: string;
  correlationId: string;
  dealId: string;
}>;

/** §9.2 stable result codes. These are non-error results, not typed failures. */
export type ExpireInvitationIfDueResult = Readonly<{
  outcome: 'EXPIRED_NOW' | 'NO_OP_NOT_DUE' | 'NO_OP_TIMER_CONSUMED' | 'NO_OP_ALREADY_TERMINAL';
  dealId: string;
  dealVersion: number;
}>;

/**
 * §9.2 — `ExpireInvitationIfDue` is trusted and **state-idempotent**: it deliberately takes no
 * caller idempotency key, because repeating it can only ever re-observe committed state.
 *
 * Only a real materialization appends an audit event and increments the version; every no-op
 * outcome creates no duplicate transition, which is what makes repeated or concurrent runs after
 * a consumed timer harmless (E40).
 */
export async function expireInvitationIfDue(
  pool: pg.Pool,
  ports: KernelPorts,
  input: ExpireInvitationIfDueInput,
): Promise<ExpireInvitationIfDueResult> {
  const dealId = requireCanonicalUuid(input.dealId, 'dealId');
  requireCanonicalUuid(input.correlationId, 'correlationId');

  try {
    return await withTransaction(pool, async (sql): Promise<ExpireInvitationIfDueResult> => {
      const dealRow = await lockDeal(sql, dealId);
      if (!dealRow) throw new Spec001Error('DEAL_NOT_FOUND');
      const commandTime = await captureCommandTime(sql);
      const deal = toDealState(dealRow);

      // Terminal state is checked before expiry, matching the §23.3 precedence.
      if (isTerminal(deal))
        return { outcome: 'NO_OP_ALREADY_TERMINAL', dealId, dealVersion: deal.version };

      // §9 — first mutual acceptance permanently consumes the invitation timer, so an accepted
      // Deal can never be terminalized later by the original invite deadline.
      if (deal.firstMutualAcceptedAt !== null)
        return { outcome: 'NO_OP_TIMER_CONSUMED', dealId, dealVersion: deal.version };

      if (!isEffectivelyExpired(deal, commandTime))
        return { outcome: 'NO_OP_NOT_DUE', dealId, dealVersion: deal.version };

      const dealVersion = await latchInvitationExpiry(sql, ports, {
        dealRow,
        commandTime,
        correlationId: input.correlationId,
        actorScope: input.actorScope,
      });
      return { outcome: 'EXPIRED_NOW', dealId, dealVersion };
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
