import {
  MAX_CANONICAL_BYTES,
  Spec001Error,
  assertRawTermsWithinCap,
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
  type CounterpartyTarget,
  type JsonNode,
  type KernelPorts,
} from '@dhamani/domain';
import {
  captureCommandTime,
  isUniqueViolation,
  mapDatabaseError,
  withTransaction,
  type Sql,
  type KernelDatabase,
} from '../database.js';
import { claimIdempotency, settleIdempotency } from '../idempotency-store.js';
import { appendAuditEvent, insertResponse } from '../repository.js';

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
  pool: KernelDatabase,
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
  const termsCanonicalBytes = new TextEncoder().encode(canonicalizeJsonNode(termsNode));
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

  // §5.3 — a public-reference collision aborts the whole birth transaction, which is then retried
  // under the same semantic idempotency key with a newly generated reference and freshly
  // generated Deal/R1 ids. Only the identified reference unique violation is retryable here.
  // The initial birth attempt is followed by at most ten collision retries (§5.3): eleven total
  // transactions only when every preceding attempt hit the identified reference constraint.
  for (let attempt = 0; attempt <= MAX_REFERENCE_COLLISION_RETRIES; attempt += 1) {
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
    }
  }
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
    termsNode: JsonNode;
    termsCanonicalBytes: Uint8Array;
  },
): Promise<CreateFormalDealResult> {
  const claim = await claimIdempotency(sql, {
    recordId: ports.newUuidV7(),
    scope: principalScope(prepared.actorPrincipalId),
    commandType: 'CreateFormalDeal',
    idempotencyKey: input.idempotencyKey,
    fingerprint: prepared.fingerprint,
  });
  if (claim.status === 'REPLAY') return replayResult(claim.stored.outcome);

  // §5.3 — one PostgreSQL clock_timestamp() captured inside the birth transaction immediately
  // before authoritative birth validation and writes, used for every timestamp this command
  // writes.
  const commandTime = await captureCommandTime(sql);

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

  await sql.query(
    `INSERT INTO "DealPartySlot"
       ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
     VALUES ($1,$2,$3::"DealType",'CREATOR',$4::"PartyRole",$5,NULL,$6,$6),
            ($7,$2,$3::"DealType",'COUNTERPARTY',$8::"PartyRole",$9,$10,$6,$11)`,
    [
      ports.newUuidV7(),
      dealId,
      dealType,
      input.creatorRole,
      prepared.actorPrincipalId,
      commandTime,
      ports.newUuidV7(),
      counterpartyRole,
      target.kind === 'PRINCIPAL' ? target.principalId : null,
      target.kind === 'PENDING_INVITE' ? target.pendingInviteId : null,
      target.kind === 'PRINCIPAL' ? commandTime : null,
    ],
  );

  // §14 — the revision creator's acceptance is a real immutable row written in the same
  // transaction as the revision, never a UI simulation or a later derived assumption.
  await insertResponse(sql, ports, {
    dealId,
    revisionId,
    principalId: prepared.actorPrincipalId,
    responseKind: 'ACCEPT',
    responseOrigin: 'REVISION_CREATOR_AUTO',
    commandTime,
  });

  const actorScope = principalScope(prepared.actorPrincipalId);
  const audit = (eventType: string, metadata: Record<string, unknown>): Promise<void> =>
    appendAuditEvent(sql, ports, {
      dealId,
      eventType,
      actorScope,
      targetRevisionId: revisionId,
      commandTime,
      dealVersion: 1,
      correlationId: input.correlationId,
      metadata,
    });
  await audit('DEAL_CREATED', { publicReference, dealType });
  // Safe metadata only: the revision hash, never the terms payload itself (§26).
  await audit('REVISION_CREATED', {
    revisionNumber: 1,
    integrityFingerprint: hex(integrity.integrityFingerprint),
  });
  await audit('REVISION_ACCEPTED_AUTO', { revisionNumber: 1 });

  // Only immutable commit-time facts are stored; `replayed` is a property of the response, not a
  // stored fact (§22.5).
  // §22.5 — stored under its immutable identity (`revisionId`: the R1 this birth created), not
  // under a name that reads as the Deal's *current* revision. The caller-facing field keeps its
  // contract name and is mapped from this immutable fact.
  const committedFacts = {
    dealId,
    publicReference,
    revisionId,
    revisionNumber: 1,
    dealVersion: 1,
    sentAt: commandTime.toISOString(),
    inviteExpiresAt: inviteExpiresAt.toISOString(),
  };
  await settleIdempotency(sql, claim.recordId, 'SUCCESS', commandTime, committedFacts);
  // The caller-facing shape is built explicitly so the internal stored key never leaks into it.
  return {
    dealId: committedFacts.dealId,
    publicReference: committedFacts.publicReference,
    currentRevisionId: committedFacts.revisionId,
    revisionNumber: committedFacts.revisionNumber,
    dealVersion: committedFacts.dealVersion,
    sentAt: committedFacts.sentAt,
    inviteExpiresAt: committedFacts.inviteExpiresAt,
    replayed: false,
  };
}

function replayResult(outcome: Record<string, unknown>): CreateFormalDealResult {
  return {
    dealId: String(outcome.dealId),
    publicReference: String(outcome.publicReference),
    // Decoded from the immutable R1 identity committed by the original birth.
    currentRevisionId: String(outcome.revisionId),
    revisionNumber: Number(outcome.revisionNumber),
    dealVersion: Number(outcome.dealVersion),
    sentAt: String(outcome.sentAt),
    inviteExpiresAt: String(outcome.inviteExpiresAt),
    replayed: true,
  };
}
