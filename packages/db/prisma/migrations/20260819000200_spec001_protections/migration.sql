-- SPEC-001 append-only and immutability protections (§24.7, §25).
--
-- Threat-model boundary (§25): these protections are not claimed to stop a superuser or the
-- migration owner. The guarantee is against the runtime application credential and against
-- ordinary application paths. Every protective trigger is created ENABLE ALWAYS so that setting
-- session_replication_role = 'replica' does not silently disable it.

-- ---------------------------------------------------------------------------
-- Generic append-only rejection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION spec001_reject_row_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SPEC001_APPEND_ONLY_VIOLATION: % on % is forbidden',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE OR REPLACE FUNCTION spec001_reject_truncate() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SPEC001_TRUNCATE_FORBIDDEN: % is protected', TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;

-- AgreementRevision — immutable contractual history.
CREATE TRIGGER "AgreementRevision_no_update"
  BEFORE UPDATE ON "AgreementRevision"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "AgreementRevision" ENABLE ALWAYS TRIGGER "AgreementRevision_no_update";

CREATE TRIGGER "AgreementRevision_no_delete"
  BEFORE DELETE ON "AgreementRevision"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "AgreementRevision" ENABLE ALWAYS TRIGGER "AgreementRevision_no_delete";

CREATE TRIGGER "AgreementRevision_no_truncate"
  BEFORE TRUNCATE ON "AgreementRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION spec001_reject_truncate();
ALTER TABLE "AgreementRevision" ENABLE ALWAYS TRIGGER "AgreementRevision_no_truncate";

-- RevisionResponse — a participant can never overwrite or erase a contractual response.
CREATE TRIGGER "RevisionResponse_no_update"
  BEFORE UPDATE ON "RevisionResponse"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "RevisionResponse" ENABLE ALWAYS TRIGGER "RevisionResponse_no_update";

CREATE TRIGGER "RevisionResponse_no_delete"
  BEFORE DELETE ON "RevisionResponse"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "RevisionResponse" ENABLE ALWAYS TRIGGER "RevisionResponse_no_delete";

CREATE TRIGGER "RevisionResponse_no_truncate"
  BEFORE TRUNCATE ON "RevisionResponse"
  FOR EACH STATEMENT EXECUTE FUNCTION spec001_reject_truncate();
ALTER TABLE "RevisionResponse" ENABLE ALWAYS TRIGGER "RevisionResponse_no_truncate";

-- DealAgreementAuditEvent — append-only audit history.
CREATE TRIGGER "DealAgreementAuditEvent_no_update"
  BEFORE UPDATE ON "DealAgreementAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "DealAgreementAuditEvent" ENABLE ALWAYS TRIGGER "DealAgreementAuditEvent_no_update";

CREATE TRIGGER "DealAgreementAuditEvent_no_delete"
  BEFORE DELETE ON "DealAgreementAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "DealAgreementAuditEvent" ENABLE ALWAYS TRIGGER "DealAgreementAuditEvent_no_delete";

CREATE TRIGGER "DealAgreementAuditEvent_no_truncate"
  BEFORE TRUNCATE ON "DealAgreementAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION spec001_reject_truncate();
ALTER TABLE "DealAgreementAuditEvent" ENABLE ALWAYS TRIGGER "DealAgreementAuditEvent_no_truncate";

-- Deal and DealPartySlot are never hard-deleted or truncated by normal product behavior (§20).
CREATE TRIGGER "Deal_no_delete"
  BEFORE DELETE ON "Deal"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "Deal" ENABLE ALWAYS TRIGGER "Deal_no_delete";

CREATE TRIGGER "Deal_no_truncate"
  BEFORE TRUNCATE ON "Deal"
  FOR EACH STATEMENT EXECUTE FUNCTION spec001_reject_truncate();
ALTER TABLE "Deal" ENABLE ALWAYS TRIGGER "Deal_no_truncate";

CREATE TRIGGER "DealPartySlot_no_delete"
  BEFORE DELETE ON "DealPartySlot"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "DealPartySlot" ENABLE ALWAYS TRIGGER "DealPartySlot_no_delete";

CREATE TRIGGER "DealPartySlot_no_truncate"
  BEFORE TRUNCATE ON "DealPartySlot"
  FOR EACH STATEMENT EXECUTE FUNCTION spec001_reject_truncate();
ALTER TABLE "DealPartySlot" ENABLE ALWAYS TRIGGER "DealPartySlot_no_truncate";

CREATE TRIGGER "ApplicationIdempotencyRecord_no_delete"
  BEFORE DELETE ON "ApplicationIdempotencyRecord"
  FOR EACH ROW EXECUTE FUNCTION spec001_reject_row_mutation();
ALTER TABLE "ApplicationIdempotencyRecord"
  ENABLE ALWAYS TRIGGER "ApplicationIdempotencyRecord_no_delete";

CREATE TRIGGER "ApplicationIdempotencyRecord_no_truncate"
  BEFORE TRUNCATE ON "ApplicationIdempotencyRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION spec001_reject_truncate();
ALTER TABLE "ApplicationIdempotencyRecord"
  ENABLE ALWAYS TRIGGER "ApplicationIdempotencyRecord_no_truncate";

-- ---------------------------------------------------------------------------
-- Deal immutability and set-once transitions (§24.7)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION spec001_deal_update_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."publicReference" <> OLD."publicReference"
     OR NEW."dealType" <> OLD."dealType"
     OR NEW."sentAt" <> OLD."sentAt"
     OR NEW."inviteExpiresAt" <> OLD."inviteExpiresAt"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'SPEC001_DEAL_IDENTITY_IMMUTABLE: formal identity/timer fields cannot change'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- firstMutualAcceptedAt: NULL may become non-null exactly once, and is never cleared.
  IF OLD."firstMutualAcceptedAt" IS NOT NULL
     AND NEW."firstMutualAcceptedAt" IS DISTINCT FROM OLD."firstMutualAcceptedAt" THEN
    RAISE EXCEPTION 'SPEC001_FIRST_MUTUAL_ACCEPTED_AT_SET_ONCE: value cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Terminal reason/time: NULL may become one valid value exactly once, never cleared/rewritten.
  IF OLD."terminationReason" IS NOT NULL
     AND (NEW."terminationReason" IS DISTINCT FROM OLD."terminationReason"
          OR NEW."terminatedAt" IS DISTINCT FROM OLD."terminatedAt") THEN
    RAISE EXCEPTION 'SPEC001_TERMINAL_STATE_SET_ONCE: terminal reason/time cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- §23.4 — exactly one version increment per successful authoritative command.
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'SPEC001_DEAL_VERSION_MUST_INCREMENT_BY_ONE: % -> %',
      OLD."version", NEW."version"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Deal_update_guard"
  BEFORE UPDATE ON "Deal"
  FOR EACH ROW EXECUTE FUNCTION spec001_deal_update_guard();
ALTER TABLE "Deal" ENABLE ALWAYS TRIGGER "Deal_update_guard";

-- ---------------------------------------------------------------------------
-- DealPartySlot immutability and one-time binding (§7, §8)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION spec001_deal_party_slot_update_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."dealId" <> OLD."dealId"
     OR NEW."dealType" <> OLD."dealType"
     OR NEW."slotKind" <> OLD."slotKind"
     OR NEW."role" <> OLD."role"
     OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."pendingInviteId" IS DISTINCT FROM OLD."pendingInviteId" THEN
    RAISE EXCEPTION 'SPEC001_SLOT_IMMUTABLE: slot identity/role/type/provenance cannot change'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A bound Principal can never be replaced or cleared; binding happens exactly once.
  IF OLD."principalId" IS NOT NULL
     AND NEW."principalId" IS DISTINCT FROM OLD."principalId" THEN
    RAISE EXCEPTION 'SPEC001_SLOT_PRINCIPAL_SET_ONCE: bound principal cannot be replaced'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD."boundAt" IS NOT NULL AND NEW."boundAt" IS DISTINCT FROM OLD."boundAt" THEN
    RAISE EXCEPTION 'SPEC001_SLOT_BOUND_AT_SET_ONCE: boundAt cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "DealPartySlot_update_guard"
  BEFORE UPDATE ON "DealPartySlot"
  FOR EACH ROW EXECUTE FUNCTION spec001_deal_party_slot_update_guard();
ALTER TABLE "DealPartySlot" ENABLE ALWAYS TRIGGER "DealPartySlot_update_guard";

-- ---------------------------------------------------------------------------
-- Idempotency claim identity is immutable; only the stored outcome may be completed (§22.5)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION spec001_idempotency_update_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."scope" <> OLD."scope"
     OR NEW."commandType" <> OLD."commandType"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestFingerprint" <> OLD."requestFingerprint"
     OR NEW."commandTime" <> OLD."commandTime" THEN
    RAISE EXCEPTION 'SPEC001_IDEMPOTENCY_CLAIM_IMMUTABLE: claim identity cannot change'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ApplicationIdempotencyRecord_update_guard"
  BEFORE UPDATE ON "ApplicationIdempotencyRecord"
  FOR EACH ROW EXECUTE FUNCTION spec001_idempotency_update_guard();
ALTER TABLE "ApplicationIdempotencyRecord"
  ENABLE ALWAYS TRIGGER "ApplicationIdempotencyRecord_update_guard";

-- ---------------------------------------------------------------------------
-- Exactly two complementary party slots per committed Deal (§24.4)
-- ---------------------------------------------------------------------------
-- A CHECK constraint cannot read another row, so the pair rule is a deferred constraint trigger.
-- It is deferred because Deal and both slots are written in one birth transaction.
CREATE OR REPLACE FUNCTION spec001_deal_party_pair_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  creator_count INTEGER;
  counterparty_count INTEGER;
  distinct_roles INTEGER;
  bound_principals INTEGER;
  distinct_principals INTEGER;
BEGIN
  SELECT
    count(*) FILTER (WHERE "slotKind" = 'CREATOR'),
    count(*) FILTER (WHERE "slotKind" = 'COUNTERPARTY'),
    count(DISTINCT "role"),
    count("principalId"),
    count(DISTINCT "principalId")
  INTO creator_count, counterparty_count, distinct_roles, bound_principals, distinct_principals
  FROM "DealPartySlot"
  WHERE "dealId" = NEW."id";

  IF creator_count <> 1 OR counterparty_count <> 1 THEN
    RAISE EXCEPTION
      'SPEC001_DEAL_REQUIRES_EXACTLY_TWO_SLOTS: creator=% counterparty=%',
      creator_count, counterparty_count
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The two slots must carry the complementary role pair, never the same role twice.
  IF distinct_roles <> 2 THEN
    RAISE EXCEPTION 'SPEC001_DEAL_ROLES_MUST_BE_COMPLEMENTARY: distinct roles=%', distinct_roles
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The same Principal may never occupy both slots.
  IF bound_principals <> distinct_principals THEN
    RAISE EXCEPTION 'SPEC001_SAME_PRINCIPAL_BOTH_SIDES: duplicate principal across slots'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Deal_party_pair_guard"
  AFTER INSERT ON "Deal"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION spec001_deal_party_pair_guard();

-- ---------------------------------------------------------------------------
-- A committed idempotency record always carries a real outcome (§22.5)
-- ---------------------------------------------------------------------------
-- PENDING exists only while the claiming transaction is open. Checking this at COMMIT rather
-- than per-statement is what allows the claim-then-complete protocol while still making a
-- committed PENDING record impossible.
CREATE OR REPLACE FUNCTION spec001_idempotency_outcome_settled() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  settled_kind TEXT;
BEGIN
  -- A deferred constraint trigger fires at COMMIT with the NEW snapshot captured when the event
  -- was queued, so NEW still reads 'PENDING' even after the claim was settled later in the same
  -- transaction. The current row must therefore be re-read rather than trusting NEW.
  SELECT "outcomeKind" INTO settled_kind
    FROM "ApplicationIdempotencyRecord" WHERE "id" = NEW."id";
  IF settled_kind IS NULL THEN
    RETURN NULL;
  END IF;
  IF settled_kind = 'PENDING' THEN
    RAISE EXCEPTION 'SPEC001_IDEMPOTENCY_OUTCOME_UNSETTLED: claim committed without an outcome'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ApplicationIdempotencyRecord_outcome_settled"
  AFTER INSERT OR UPDATE ON "ApplicationIdempotencyRecord"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION spec001_idempotency_outcome_settled();
