import type pg from 'pg';
import {
  Spec001Error,
  canonicalizeJsonNode,
  computeIdempotencyFingerprint,
  computeRevisionIntegrity,
  deriveCounterpartyRole,
  parseStrictJsonText,
  principalScope,
  requireCanonicalUuid,
  requireDealType,
  resolveTermsSchema,
  validateTermsEnvelope,
  assertRawTermsWithinCap,
  MAX_CANONICAL_BYTES,
  type CounterpartyTarget,
  type KernelPorts,
} from '@dhamani/domain';
import {
  captureCommandTime,
  isUniqueViolation,
  mapDatabaseError,
  withTransaction,
  type Sql,
} from '../database.js';
import { claimIdempotency, settleIdempotency } from '../idempotency-store.js';

const INVITE_WINDOW_HOURS = 168;
const MAX_REFERENCE_COLLISION_RETRIES = 10;
const PUBLIC_REFERENCE_UNIQUE_CONSTRAINT = 'Deal_publicReference_key';

export type CreateFormalDealInput = Readonly<{
  actorPrincipalId: string;
  correlationId: string;
  dealType: string;
  creatorRole: string;
  counterpartyTarget: CounterpartyTarget;
  termsSchemaId: string;
  rawTerms: Uint8Array;
  idempotencyKey: string;
}>;

export type CreateFormalDealResult = Readonly<{
  dealId: string;
  publicReference: string;
  currentRevisionId: string;
  revisionNumber: number;
  dealVersion: number;
  sentAt: string;
  inviteExpiresAt: string;
  replayed: boolean;
}>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * §5 — `CreateFormalDeal`. This is the confirmed Send after Review, not a Draft save: a Formal
 * Deal exists only when this transaction commits.
 *
 * §23.3 ordering for this command is: pre-fingerprint strict terms checks -> idempotency ->
 * actor/self-deal/target checks -> schema/common/type validation -> atomic birth.
 */
export async function createFormalDeal(
  pool: pg.Pool,
  ports: KernelPorts,
  input: CreateFormalDealInput,
): Promise<CreateFormalDealResult> {
  // ---- §22.2 pre-fingerprint strict terms checks (no key is reserved if any of these fail) ----
  assertRawTermsWithinCap(input.rawTerms); // step 0: raw 1 MiB cap, before any decode
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input.rawTerms);
  } catch {
    throw new Spec001Error('TERMS_JSON_UNSUPPORTED_UNICODE', { reason: 'INVALID_UTF8' });
  }
  const termsNode = parseStrictJsonText(decoded);
  const termsCanonicalText = canonicalizeJsonNode(termsNode);
  const termsCanonicalBytes = new TextEncoder().encode(termsCanonicalText);
  if (termsCanonicalBytes.byteLength > MAX_CANONICAL_BYTES)
    throw new Spec001Error('TERMS_PAYLOAD_TOO_LARGE');

  const actorPrincipalId = requireCanonicalUuid(input.actorPrincipalId, 'actorPrincipalId');
  requireCanonicalUuid(input.correlationId, 'correlationId');

  const fingerprint = computeIdempotencyFingerprint(
    {
      commandType: 'CreateFormalDeal',
      dealType: input.dealType,
      creatorRole: input.creatorRole,
      counterpartyTarget: input.counterpartyTarget,
      termsSchemaId: input.termsSchemaId,
      termsCanonicalSha256Hex: hex(ports.sha256(termsCanonicalBytes)),
    },
    ports.sha256,
  );

  // §5.3 — a public-reference collision aborts the whole birth transaction and it is retried
  // under the same semantic idempotency key with a newly generated reference and freshly
  // generated Deal/R1 ids. Only the identified reference unique violation is retryable here.
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_REFERENCE_COLLISION_RETRIES; attempt += 1) {
    try {
      return await withTransaction(pool, (sql) =>
        birthTransaction(sql, ports, input, {
          actorPrincipalId,
          fingerprint,
          termsNode,
          termsCanonicalBytes,
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error, PUBLIC_REFERENCE_UNIQUE_CONSTRAINT))
        throw mapDatabaseError(error);
      lastError = error;
    }
  }
  void lastError;
  // Exhaustion commits no Formal Deal and no idempotency success.
  throw new Spec001Error('DEAL_REFERENCE_GENERATION_FAILED');
}

async function birthTransaction(
  sql: Sql,
  ports: KernelPorts,
  input: CreateFormalDealInput,
  prepared: {
    actorPrincipalId: string;
    fingerprint: Uint8Array;
    termsNode: ReturnType<typeof parseStrictJsonText>;
    termsCanonicalBytes: Uint8Array;
  },
): Promise<CreateFormalDealResult> {
  // §5.3 — one PostgreSQL clock_timestamp() captured inside the transaction immediately before
  // authoritative birth validation and writes, used for every timestamp this command writes.
  const commandTime = await captureCommandTime(sql);

  const claim = await claimIdempotency(sql, {
    recordId: ports.newUuidV7(),
    scope: principalScope(prepared.actorPrincipalId),
    commandType: 'CreateFormalDeal',
    idempotencyKey: input.idempotencyKey,
    fingerprint: prepared.fingerprint,
    commandTime,
  });
  if (claim.status === 'REPLAY') return replayResult(claim.stored.outcome);

  // ---- actor / self-deal / target checks ----
  const dealType = requireDealType(input.dealType);
  const counterpartyRole = deriveCounterpartyRole(dealType, input.creatorRole);
  const target = input.counterpartyTarget;
  if (target.kind === 'PRINCIPAL') {
    requireCanonicalUuid(target.principalId, 'counterpartyTarget.principalId');
    if (target.principalId === prepared.actorPrincipalId)
      throw new Spec001Error('SAME_PARTICIPANT_BOTH_SIDES');
  } else {
    requireCanonicalUuid(target.pendingInviteId, 'counterpartyTarget.pendingInviteId');
  }

  // ---- schema registry + common/type-specific validation ----
  const schema = resolveTermsSchema(input.termsSchemaId, dealType);
  const terms = validateTermsEnvelope(prepared.termsNode, schema);
  if (!bytesEqual(terms.canonicalBytes, prepared.termsCanonicalBytes))
    throw new Spec001Error('REVISION_INTEGRITY_FAILURE', { reason: 'CANONICAL_BYTES_UNSTABLE' });

  // ---- atomic birth ----
  // Ids are pre-generated application-side so Deal and R1 can reference each other inside one
  // transaction under the deferred composite FK (§24.2).
  const dealId = ports.newUuidV7();
  const revisionId = ports.newUuidV7();
  const publicReference = ports.newPublicReference();
  const inviteExpiresAt = new Date(commandTime.getTime() + INVITE_WINDOW_HOURS * 3600 * 1000);

  const integrity = computeRevisionIntegrity(
    {
      dealId,
      dealType,
      predecessorRevisionId: null,
      revisionNumber: 1,
      termsPayloadCanonicalText: terms.canonicalText,
      termsSchemaId: schema.termsSchemaId,
    },
    ports.sha256,
  );

  await sql.query(
    `INSERT INTO "Deal"
       ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt",
        "firstMutualAcceptedAt","terminationReason","terminatedAt","version","createdAt")
     VALUES ($1,$2,$3::"DealType",$4,$5,$6,NULL,NULL,NULL,1,$5)`,
    [dealId, publicReference, dealType, revisionId, commandTime, inviteExpiresAt],
  );

  await sql.query(
    `INSERT INTO "AgreementRevision"
       ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId",
        "termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes",
        "integrityFingerprint","createdAt")
     VALUES ($1,$2,1,NULL,$3,$4,$5,$6,$7,$8)`,
    [
      revisionId,
      dealId,
      prepared.actorPrincipalId,
      schema.termsSchemaId,
      Buffer.from(terms.canonicalBytes),
      Buffer.from(integrity.preimageCanonicalBytes),
      Buffer.from(integrity.integrityFingerprint),
      commandTime,
    ],
  );

  const creatorSlotId = ports.newUuidV7();
  const counterpartySlotId = ports.newUuidV7();
  await sql.query(
    `INSERT INTO "DealPartySlot"
       ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
     VALUES ($1,$2,$3::"DealType",'CREATOR',$4::"PartyRole",$5,NULL,$6,$6),
            ($7,$2,$3::"DealType",'COUNTERPARTY',$8::"PartyRole",$9,$10,$6,$11)`,
    [
      creatorSlotId,
      dealId,
      dealType,
      input.creatorRole,
      prepared.actorPrincipalId,
      commandTime,
      counterpartySlotId,
      counterpartyRole,
      target.kind === 'PRINCIPAL' ? target.principalId : null,
      target.kind === 'PENDING_INVITE' ? target.pendingInviteId : null,
      target.kind === 'PRINCIPAL' ? commandTime : null,
    ],
  );

  // §14 — the revision creator's acceptance is a real immutable row written in the same
  // transaction as the revision, never a UI simulation or a later derived assumption.
  await sql.query(
    `INSERT INTO "RevisionResponse"
       ("id","dealId","revisionId","principalId","responseKind","responseOrigin","createdAt")
     VALUES ($1,$2,$3,$4,'ACCEPT','REVISION_CREATOR_AUTO',$5)`,
    [ports.newUuidV7(), dealId, revisionId, prepared.actorPrincipalId, commandTime],
  );

  const actorScope = principalScope(prepared.actorPrincipalId);
  await appendAudit(sql, ports, {
    dealId,
    eventType: 'DEAL_CREATED',
    actorScope,
    targetRevisionId: revisionId,
    commandTime,
    dealVersion: 1,
    correlationId: input.correlationId,
    metadata: { publicReference, dealType },
  });
  await appendAudit(sql, ports, {
    dealId,
    eventType: 'REVISION_CREATED',
    actorScope,
    targetRevisionId: revisionId,
    commandTime,
    dealVersion: 1,
    correlationId: input.correlationId,
    // Safe metadata only: the revision hash, never the terms payload itself (§26).
    metadata: { revisionNumber: 1, integrityFingerprint: hex(integrity.integrityFingerprint) },
  });
  await appendAudit(sql, ports, {
    dealId,
    eventType: 'REVISION_ACCEPTED_AUTO',
    actorScope,
    targetRevisionId: revisionId,
    commandTime,
    dealVersion: 1,
    correlationId: input.correlationId,
    metadata: { revisionNumber: 1 },
  });

  // Only immutable commit-time facts are stored; `replayed` is a per-call property of the
  // response, never a stored fact (§22.5).
  const committedFacts = {
    dealId,
    publicReference,
    currentRevisionId: revisionId,
    revisionNumber: 1,
    dealVersion: 1,
    sentAt: commandTime.toISOString(),
    inviteExpiresAt: inviteExpiresAt.toISOString(),
  };
  await settleIdempotency(sql, claim.recordId, 'SUCCESS', committedFacts);
  return { ...committedFacts, replayed: false };
}

function replayResult(outcome: Record<string, unknown>): CreateFormalDealResult {
  return {
    dealId: String(outcome.dealId),
    publicReference: String(outcome.publicReference),
    currentRevisionId: String(outcome.currentRevisionId),
    revisionNumber: Number(outcome.revisionNumber),
    dealVersion: Number(outcome.dealVersion),
    sentAt: String(outcome.sentAt),
    inviteExpiresAt: String(outcome.inviteExpiresAt),
    replayed: true,
  };
}

export type AuditInput = Readonly<{
  dealId: string;
  eventType: string;
  actorScope: string;
  targetRevisionId: string | null;
  commandTime: Date;
  dealVersion: number;
  correlationId: string;
  metadata: Record<string, unknown>;
}>;

/** §26 — every meaningful committed write appends an audit event in the same transaction. */
export async function appendAudit(sql: Sql, ports: KernelPorts, event: AuditInput): Promise<void> {
  await sql.query(
    `INSERT INTO "DealAgreementAuditEvent"
       ("id","dealId","eventType","actorScope","targetRevisionId","commandTime","dealVersion",
        "correlationId","metadata")
     VALUES ($1,$2,$3::"DealAuditEventType",$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      ports.newUuidV7(),
      event.dealId,
      event.eventType,
      event.actorScope,
      event.targetRevisionId,
      event.commandTime,
      event.dealVersion,
      event.correlationId,
      JSON.stringify(event.metadata),
    ],
  );
}
