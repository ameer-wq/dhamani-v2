import type pg from 'pg';
import {
  MAX_CANONICAL_BYTES,
  Spec001Error,
  assertRawTermsWithinCap,
  canonicalizeJsonNode,
  computeIdempotencyFingerprint,
  computeRevisionIntegrity,
  currentRevision,
  actorMayActOnCurrentRevision,
  hasRemainingCredits,
  isBoundParticipant,
  nextRevisionNumber,
  parseStrictJsonText,
  principalScope,
  requireCanonicalUuid,
  resolveTermsSchema,
  termsComparisonCanonicalText,
  validateTermsEnvelope,
  type KernelPorts,
} from '@dhamani/domain';
import {
  appendAuditEvent,
  assertCurrentRevisionIntegrity,
  insertResponse,
  insertSuccessorRevision,
  updateDeal,
} from '../repository.js';
import { runKeyedDealCommand } from './shared.js';

export type ProposeChangesInput = Readonly<{
  actorPrincipalId: string;
  correlationId: string;
  dealId: string;
  /** Caller's exact base intent. Never retargeted from currentRevisionId. */
  baseRevisionId: string;
  termsSchemaId: string;
  rawTerms: Uint8Array;
  idempotencyKey: string;
}>;

export type ProposeChangesResult = Readonly<{
  dealId: string;
  revisionId: string;
  revisionNumber: number;
  predecessorRevisionId: string;
  dealVersion: number;
  replayed: boolean;
}>;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * §17 — `ProposeChanges` creates the successor revision. It is not a third response kind on the
 * old revision: the old revision keeps its own immutable responses (§13).
 */
export async function proposeChanges(
  pool: pg.Pool,
  ports: KernelPorts,
  input: ProposeChangesInput,
): Promise<ProposeChangesResult> {
  // §22.2 — strict raw JSON/domain/resource validation and canonicalization happen before the
  // fingerprint and before any key is reserved.
  assertRawTermsWithinCap(input.rawTerms);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input.rawTerms);
  } catch {
    throw new Spec001Error('TERMS_JSON_UNSUPPORTED_UNICODE', { reason: 'INVALID_UTF8' });
  }
  const termsNode = parseStrictJsonText(decoded);
  const proposedCanonicalText = canonicalizeJsonNode(termsNode);
  const proposedCanonicalBytes = new TextEncoder().encode(proposedCanonicalText);
  if (proposedCanonicalBytes.byteLength > MAX_CANONICAL_BYTES)
    throw new Spec001Error('TERMS_PAYLOAD_TOO_LARGE');

  const actorPrincipalId = requireCanonicalUuid(input.actorPrincipalId, 'actorPrincipalId');
  const dealId = requireCanonicalUuid(input.dealId, 'dealId');
  const baseRevisionId = requireCanonicalUuid(input.baseRevisionId, 'baseRevisionId');
  requireCanonicalUuid(input.correlationId, 'correlationId');

  return runKeyedDealCommand<ProposeChangesResult>(pool, ports, {
    commandType: 'ProposeChanges',
    scope: principalScope(actorPrincipalId),
    idempotencyKey: input.idempotencyKey,
    fingerprint: computeIdempotencyFingerprint(
      {
        commandType: 'ProposeChanges',
        dealId,
        baseRevisionId,
        termsSchemaId: input.termsSchemaId,
        termsCanonicalSha256Hex: hex(ports.sha256(proposedCanonicalBytes)),
      },
      ports.sha256,
    ),
    dealId,
    correlationId: input.correlationId,
    actorScope: principalScope(actorPrincipalId),
    replay: (facts) => ({
      dealId: String(facts.dealId),
      revisionId: String(facts.revisionId),
      revisionNumber: Number(facts.revisionNumber),
      predecessorRevisionId: String(facts.predecessorRevisionId),
      dealVersion: Number(facts.dealVersion),
      replayed: true,
    }),
    execute: async ({ sql, snapshot, commandTime, dealRow, actorScope, correlationId }) => {
      if (!isBoundParticipant(snapshot, actorPrincipalId))
        throw new Spec001Error('NOT_DEAL_PARTICIPANT');

      const base = snapshot.revisions.find((revision) => revision.id === baseRevisionId);
      if (!base) throw new Spec001Error('REVISION_NOT_FOUND');
      const current = currentRevision(snapshot);
      if (base.id !== current.id)
        throw new Spec001Error('REVISION_NOT_CURRENT', {
          expectedRevisionId: current.id,
          actualRevisionId: base.id,
        });

      const currentTerms = await assertCurrentRevisionIntegrity(
        sql,
        dealId,
        dealRow.dealType,
        current.id,
        ports,
      );

      // §23.3 step 12 — turn-taking. A revision's creator may not self-spam successors while the
      // counterpart's decision is still awaited.
      if (!actorMayActOnCurrentRevision(snapshot, actorPrincipalId, commandTime))
        throw new Spec001Error('ACTOR_MUST_WAIT_FOR_COUNTERPARTY');

      // §23.3 step 13 — credits derived from immutable history, never a mutable counter.
      if (!hasRemainingCredits(snapshot, actorPrincipalId))
        throw new Spec001Error('MODIFICATION_LIMIT_REACHED');

      // §23.3 step 14 — R1 pins the schema for the Deal's lifetime; a known but different schema
      // is a mismatch rather than an unsupported schema (E37).
      const r1 = snapshot.revisions.find((revision) => revision.revisionNumber === 1);
      const pinnedSchemaId = r1?.termsSchemaId ?? currentTerms.termsSchemaId;
      if (input.termsSchemaId !== pinnedSchemaId) {
        // Distinguish "not a real schema at all" from "real schema, but not the pinned one".
        resolveTermsSchema(input.termsSchemaId, dealRow.dealType as never);
        throw new Spec001Error('TERMS_SCHEMA_MISMATCH');
      }
      const schema = resolveTermsSchema(pinnedSchemaId, dealRow.dealType as never);
      const terms = validateTermsEnvelope(termsNode, schema);

      // §23.3 step 15 / §17.1 — canonical equality of the (termsPayload, termsSchemaId) pair
      // only. The whole integrity fingerprint is deliberately not compared, because it also
      // covers revision number and predecessor and so could never collide.
      const currentComparison = termsComparisonCanonicalText(
        new TextDecoder().decode(currentTerms.termsPayloadCanonicalBytes),
        currentTerms.termsSchemaId,
      );
      const proposedComparison = termsComparisonCanonicalText(terms.canonicalText, pinnedSchemaId);
      if (currentComparison === proposedComparison)
        throw new Spec001Error('REVISION_TERMS_UNCHANGED');

      // ---- §17.4 atomic effects ----
      const revisionId = ports.newUuidV7();
      const revisionNumber = nextRevisionNumber(snapshot);
      const integrity = computeRevisionIntegrity(
        {
          dealId,
          dealType: dealRow.dealType as never,
          predecessorRevisionId: current.id,
          revisionNumber,
          termsPayloadCanonicalText: terms.canonicalText,
          termsSchemaId: pinnedSchemaId,
        },
        ports.sha256,
      );
      await insertSuccessorRevision(sql, {
        id: revisionId,
        dealId,
        revisionNumber,
        predecessorRevisionId: current.id,
        createdByPrincipalId: actorPrincipalId,
        termsSchemaId: pinnedSchemaId,
        termsPayloadCanonicalBytes: terms.canonicalBytes,
        integrityPreimageCanonicalBytes: integrity.preimageCanonicalBytes,
        integrityFingerprint: integrity.integrityFingerprint,
        commandTime,
      });
      // §14 — the successor's creator auto-accepts it in the same transaction.
      await insertResponse(sql, ports, {
        dealId,
        revisionId,
        principalId: actorPrincipalId,
        responseKind: 'ACCEPT',
        responseOrigin: 'REVISION_CREATOR_AUTO',
        commandTime,
      });
      const dealVersion = await updateDeal(sql, dealId, dealRow.version, {
        currentRevisionId: revisionId,
      });

      const audit = (eventType: string, metadata: Record<string, unknown>): Promise<void> =>
        appendAuditEvent(sql, ports, {
          dealId,
          eventType,
          actorScope,
          targetRevisionId: revisionId,
          commandTime,
          dealVersion,
          correlationId,
          metadata,
        });
      await audit('REVISION_CREATED', {
        revisionNumber,
        integrityFingerprint: hex(integrity.integrityFingerprint),
      });
      await audit('REVISION_ACCEPTED_AUTO', { revisionNumber });
      await audit('CURRENT_REVISION_ADVANCED', {
        revisionNumber,
        predecessorRevisionId: current.id,
      });

      return {
        result: {
          dealId,
          revisionId,
          revisionNumber,
          predecessorRevisionId: current.id,
          dealVersion,
          replayed: false,
        },
        storedFacts: {
          dealId,
          revisionId,
          revisionNumber,
          predecessorRevisionId: current.id,
          dealVersion,
        },
      };
    },
  });
}
