import {
  Spec001Error,
  deriveAgreementReady,
  isBoundParticipant,
  type DealSnapshot,
  type KernelPorts,
} from '@dhamani/domain';
import { captureCommandTime, withTransaction, type KernelDatabase } from './database.js';
import { loadDealSnapshot, lockDeal } from './repository.js';

/**
 * §28 — the application/API read authorization boundary.
 *
 * Every read that returns Deal content, terms, revisions, responses, participant data or
 * readiness requires an `ActorScope` that is either a Principal the trusted boundary has proven
 * to be a bound participant, or an explicitly trusted internal system scope for a named purpose.
 *
 * There is no untrusted header/body/query PrincipalId authority here, and `publicReference` is
 * never authorization: a reference-based lookup exists only behind this same boundary.
 */
export type ActorScope =
  | Readonly<{ kind: 'PARTICIPANT'; principalId: string }>
  | Readonly<{ kind: 'TRUSTED_SYSTEM'; purpose: string }>;

export type DealView = Readonly<{
  dealId: string;
  publicReference: string;
  dealType: string;
  currentRevisionId: string;
  agreementReady: boolean;
  terminationReason: string | null;
  version: number;
  snapshot: DealSnapshot;
}>;

function assertAuthorized(scope: ActorScope, snapshot: DealSnapshot): void {
  if (scope.kind === 'TRUSTED_SYSTEM') {
    if (scope.purpose.length === 0)
      throw new Spec001Error('VALIDATION_ERROR', {
        field: 'actorScope',
        reason: 'PURPOSE_REQUIRED',
      });
    return;
  }
  // An outsider Principal can never read Deal resources through this service.
  if (!isBoundParticipant(snapshot, scope.principalId))
    throw new Spec001Error('NOT_DEAL_PARTICIPANT');
}

export async function readDeal(
  pool: KernelDatabase,
  _ports: KernelPorts,
  scope: ActorScope,
  dealId: string,
): Promise<DealView> {
  return withTransaction(pool, async (sql) => {
    const row = await lockDeal(sql, dealId);
    if (!row) throw new Spec001Error('DEAL_NOT_FOUND');
    const commandTime = await captureCommandTime(sql);
    const snapshot = await loadDealSnapshot(sql, row);
    assertAuthorized(scope, snapshot);
    return Object.freeze({
      dealId: row.id,
      publicReference: row.publicReference,
      dealType: row.dealType,
      currentRevisionId: row.currentRevisionId,
      // Readiness is always server-derived here, never read from a stored flag.
      agreementReady: deriveAgreementReady(snapshot, commandTime),
      terminationReason: row.terminationReason,
      version: row.version,
      snapshot,
    });
  });
}

/**
 * Reference-based lookup exists only behind the same authorization boundary. Holding a public
 * reference grants nothing on its own (§30).
 */
export async function readDealByPublicReference(
  pool: KernelDatabase,
  ports: KernelPorts,
  scope: ActorScope,
  publicReference: string,
): Promise<DealView> {
  const located = await pool.query<{ id: string }>(
    'SELECT "id" FROM "Deal" WHERE "publicReference" = $1',
    [publicReference],
  );
  const dealId = located.rows[0]?.id;
  if (!dealId) throw new Spec001Error('DEAL_NOT_FOUND');
  return readDeal(pool, ports, scope, dealId);
}
