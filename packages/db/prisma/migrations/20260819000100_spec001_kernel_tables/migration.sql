-- SPEC-001 Deal + Agreement Kernel — tables, keys and per-row constraints (§24).
--
-- Authoritative lifecycle timestamps deliberately carry no DEFAULT now()/CURRENT_TIMESTAMP:
-- §29 requires every such value to come from the single post-lock clock_timestamp() captured by
-- the command, so a database default would silently create a second, unordered time authority.

CREATE TYPE "DealType" AS ENUM ('GOODS', 'SERVICES', 'BOOKING', 'SUBSCRIPTION', 'DIGITAL_ASSET');

CREATE TYPE "SlotKind" AS ENUM ('CREATOR', 'COUNTERPARTY');

CREATE TYPE "PartyRole" AS ENUM (
  'BUYER',
  'SELLER',
  'CLIENT',
  'SERVICE_PROVIDER',
  'CUSTOMER',
  'BOOKING_PROVIDER',
  'SUBSCRIBER',
  'SUBSCRIPTION_PROVIDER'
);

CREATE TYPE "ResponseKind" AS ENUM ('ACCEPT', 'REJECT');

CREATE TYPE "ResponseOrigin" AS ENUM ('EXPLICIT', 'REVISION_CREATOR_AUTO');

CREATE TYPE "TerminationReason" AS ENUM (
  'REJECTED',
  'INVITATION_WITHDRAWN',
  'NEGOTIATION_WITHDRAWN',
  'INVITATION_EXPIRED'
);

CREATE TYPE "DealAuditEventType" AS ENUM (
  'DEAL_CREATED',
  'COUNTERPARTY_BOUND',
  'REVISION_CREATED',
  'REVISION_ACCEPTED_AUTO',
  'REVISION_ACCEPTED_EXPLICIT',
  'REVISION_REJECTED',
  'CURRENT_REVISION_ADVANCED',
  'MUTUAL_ACCEPTANCE_REACHED',
  'INVITATION_WITHDRAWN',
  'NEGOTIATION_WITHDRAWN',
  'INVITATION_EXPIRED'
);

-- ---------------------------------------------------------------------------
-- Deal (§24.1)
-- ---------------------------------------------------------------------------
CREATE TABLE "Deal" (
  "id" UUID NOT NULL,
  "publicReference" TEXT NOT NULL,
  "dealType" "DealType" NOT NULL,
  "currentRevisionId" UUID NOT NULL,
  "sentAt" TIMESTAMPTZ(6) NOT NULL,
  "inviteExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "firstMutualAcceptedAt" TIMESTAMPTZ(6),
  "terminationReason" "TerminationReason",
  "terminatedAt" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Deal_pkey" PRIMARY KEY ("id"),
  -- Crockford Base32 excludes I, L, O and U; generation and storage are uppercase canonical.
  CONSTRAINT "Deal_publicReference_format_check" CHECK (
    "publicReference" ~ '^DH-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'
  ),
  CONSTRAINT "Deal_version_positive_check" CHECK ("version" >= 1),
  -- Terminal reason and terminal time are one fact and may only appear together (§20).
  CONSTRAINT "Deal_terminal_pairing_check" CHECK (
    ("terminationReason" IS NULL) = ("terminatedAt" IS NULL)
  ),
  -- §9: inviteExpiresAt is exactly sentAt + 168 hours; the window can never be zero or inverted.
  CONSTRAINT "Deal_invite_window_check" CHECK ("inviteExpiresAt" = "sentAt" + INTERVAL '168 hours')
);

CREATE UNIQUE INDEX "Deal_publicReference_key" ON "Deal" ("publicReference");

-- Target for the DealPartySlot composite type-consistency FK (§24.4).
CREATE UNIQUE INDEX "Deal_id_dealType_key" ON "Deal" ("id", "dealType");

-- ---------------------------------------------------------------------------
-- AgreementRevision (§12)
-- ---------------------------------------------------------------------------
CREATE TABLE "AgreementRevision" (
  "id" UUID NOT NULL,
  "dealId" UUID NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "predecessorRevisionId" UUID,
  "createdByPrincipalId" UUID NOT NULL,
  "termsSchemaId" TEXT NOT NULL,
  "termsPayloadCanonicalBytes" BYTEA NOT NULL,
  "integrityPreimageCanonicalBytes" BYTEA NOT NULL,
  "integrityFingerprint" BYTEA NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgreementRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgreementRevision_deal_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id"),
  CONSTRAINT "AgreementRevision_number_positive_check" CHECK ("revisionNumber" >= 1),
  -- R1 is the only revision without a predecessor, and it always has revisionNumber 1.
  CONSTRAINT "AgreementRevision_r1_predecessor_check" CHECK (
    ("revisionNumber" = 1) = ("predecessorRevisionId" IS NULL)
  ),
  CONSTRAINT "AgreementRevision_fingerprint_length_check" CHECK (
    octet_length("integrityFingerprint") = 32
  ),
  -- §10.3 canonical terms cap, enforced by the database and not only by application validation.
  CONSTRAINT "AgreementRevision_canonical_terms_cap_check" CHECK (
    octet_length("termsPayloadCanonicalBytes") <= 65536
  ),
  CONSTRAINT "AgreementRevision_deal_number_key" UNIQUE ("dealId", "revisionNumber")
);

-- Both column orders are required: one backs the Deal.currentRevisionId composite FK, the other
-- backs the predecessor and RevisionResponse composite FKs.
CREATE UNIQUE INDEX "AgreementRevision_dealId_id_key" ON "AgreementRevision" ("dealId", "id");
CREATE UNIQUE INDEX "AgreementRevision_id_dealId_key" ON "AgreementRevision" ("id", "dealId");

-- A successor's predecessor must belong to the same Deal: cross-Deal chaining is impossible.
ALTER TABLE "AgreementRevision"
  ADD CONSTRAINT "AgreementRevision_predecessor_same_deal_fkey"
  FOREIGN KEY ("predecessorRevisionId", "dealId")
  REFERENCES "AgreementRevision" ("id", "dealId");

-- §24.2 — a committed Deal can never point at NULL or at another Deal's revision. The constraint
-- must be DEFERRABLE INITIALLY DEFERRED because Deal and its R1 are inserted in one transaction
-- and each references the other; Prisma's schema language cannot express deferrability, so this
-- is delivered as reviewed raw SQL.
ALTER TABLE "Deal"
  ADD CONSTRAINT "Deal_currentRevision_same_deal_fkey"
  FOREIGN KEY ("id", "currentRevisionId")
  REFERENCES "AgreementRevision" ("dealId", "id")
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- DealPartySlot (§7, §24.4)
-- ---------------------------------------------------------------------------
CREATE TABLE "DealPartySlot" (
  "id" UUID NOT NULL,
  "dealId" UUID NOT NULL,
  "dealType" "DealType" NOT NULL,
  "slotKind" "SlotKind" NOT NULL,
  "role" "PartyRole" NOT NULL,
  "principalId" UUID,
  "pendingInviteId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "boundAt" TIMESTAMPTZ(6),
  CONSTRAINT "DealPartySlot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DealPartySlot_deal_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id"),
  -- dealType is a non-null immutable enforcement copy kept FK-consistent with the parent Deal;
  -- it exists purely so role/type legality is checkable by the database (§7).
  CONSTRAINT "DealPartySlot_dealType_fkey" FOREIGN KEY ("dealId", "dealType")
    REFERENCES "Deal" ("id", "dealType"),
  CONSTRAINT "DealPartySlot_bound_pairing_check" CHECK (
    ("principalId" IS NULL) = ("boundAt" IS NULL)
  ),
  -- The creator slot is bound at Deal birth and never pending.
  CONSTRAINT "DealPartySlot_creator_is_bound_check" CHECK (
    "slotKind" <> 'CREATOR' OR "principalId" IS NOT NULL
  ),
  -- Per-row legality of (dealType, role). The complementary pairing across the two rows is
  -- enforced separately by a deferred trigger, because no CHECK may read another row.
  CONSTRAINT "DealPartySlot_role_triple_check" CHECK (
    ("dealType" = 'GOODS' AND "role" IN ('BUYER', 'SELLER'))
    OR ("dealType" = 'SERVICES' AND "role" IN ('CLIENT', 'SERVICE_PROVIDER'))
    OR ("dealType" = 'BOOKING' AND "role" IN ('CUSTOMER', 'BOOKING_PROVIDER'))
    OR ("dealType" = 'SUBSCRIPTION' AND "role" IN ('SUBSCRIBER', 'SUBSCRIPTION_PROVIDER'))
    OR ("dealType" = 'DIGITAL_ASSET' AND "role" IN ('BUYER', 'SELLER'))
  ),
  -- Exactly one CREATOR and one COUNTERPARTY row can exist per Deal.
  CONSTRAINT "DealPartySlot_deal_slotKind_key" UNIQUE ("dealId", "slotKind"),
  -- Real UNIQUE (not a partial index) so it can be the target of the RevisionResponse FK, and so
  -- the same bound Principal cannot occupy both slots of one Deal.
  CONSTRAINT "DealPartySlot_deal_principal_key" UNIQUE ("dealId", "principalId")
);

-- ---------------------------------------------------------------------------
-- RevisionResponse (§13, §24.3)
-- ---------------------------------------------------------------------------
CREATE TABLE "RevisionResponse" (
  "id" UUID NOT NULL,
  "dealId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "principalId" UUID NOT NULL,
  "responseKind" "ResponseKind" NOT NULL,
  "responseOrigin" "ResponseOrigin" NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "RevisionResponse_pkey" PRIMARY KEY ("id"),
  -- The response's revision must belong to the response's Deal.
  CONSTRAINT "RevisionResponse_revision_fkey" FOREIGN KEY ("revisionId", "dealId")
    REFERENCES "AgreementRevision" ("id", "dealId"),
  -- The responder must be a bound party slot of that same Deal.
  CONSTRAINT "RevisionResponse_party_fkey" FOREIGN KEY ("dealId", "principalId")
    REFERENCES "DealPartySlot" ("dealId", "principalId"),
  -- At most one response per (revision, principal): a participant cannot overwrite a response.
  CONSTRAINT "RevisionResponse_revision_principal_key" UNIQUE ("revisionId", "principalId")
);

-- ---------------------------------------------------------------------------
-- DealAgreementAuditEvent (§26)
-- ---------------------------------------------------------------------------
CREATE TABLE "DealAgreementAuditEvent" (
  "id" UUID NOT NULL,
  "dealId" UUID NOT NULL,
  "eventType" "DealAuditEventType" NOT NULL,
  "actorScope" TEXT NOT NULL,
  "targetRevisionId" UUID,
  "commandTime" TIMESTAMPTZ(6) NOT NULL,
  "dealVersion" INTEGER NOT NULL,
  "correlationId" UUID NOT NULL,
  "metadata" JSONB NOT NULL,
  CONSTRAINT "DealAgreementAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DealAgreementAuditEvent_deal_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id"),
  CONSTRAINT "DealAgreementAuditEvent_version_positive_check" CHECK ("dealVersion" >= 1)
);

CREATE INDEX "DealAgreementAuditEvent_deal_version_idx"
  ON "DealAgreementAuditEvent" ("dealId", "dealVersion");

-- ---------------------------------------------------------------------------
-- ApplicationIdempotencyRecord (§22)
-- ---------------------------------------------------------------------------
CREATE TABLE "ApplicationIdempotencyRecord" (
  "id" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "commandType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" BYTEA NOT NULL,
  "outcomeKind" TEXT NOT NULL,
  "outcome" JSONB NOT NULL,
  -- The authoritative command timestamp is part of the committed outcome, not of the claim:
  -- §23.1 orders the claim before the Deal row lock, while §29 takes the single
  -- clock_timestamp() after that lock. It is NULL only while the claim is unsettled, and the
  -- deferred settle trigger rejects a committed row that still lacks it.
  "commandTime" TIMESTAMPTZ(6),
  CONSTRAINT "ApplicationIdempotencyRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApplicationIdempotencyRecord_fingerprint_length_check" CHECK (
    octet_length("requestFingerprint") = 32
  ),
  -- PENDING is the in-transaction claim state only. It is never visible to another transaction
  -- (the row is uncommitted) and a deferred constraint trigger rejects it at COMMIT, so a
  -- committed record always carries a real commit-time outcome (§22.5).
  CONSTRAINT "ApplicationIdempotencyRecord_outcomeKind_check" CHECK (
    "outcomeKind" IN ('PENDING', 'SUCCESS', 'TYPED_ERROR')
  ),
  -- §22.1 scope: PRINCIPAL:<id> or TRUSTED_IDENTITY:<caller>, plus command type and caller key.
  CONSTRAINT "ApplicationIdempotencyRecord_claim_key"
    UNIQUE ("scope", "commandType", "idempotencyKey")
);
