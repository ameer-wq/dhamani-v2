-- SPEC-001 — settled idempotency outcomes are immutable (§22.5, E42).
--
-- The runtime role legitimately holds column-level UPDATE on
-- ApplicationIdempotencyRecord(outcomeKind, outcome, commandTime) so it can settle its own claim.
-- Without this guard that same grant would let the runtime credential rewrite a historical
-- SUCCESS or TYPED_ERROR outcome after commit, which would destroy the immutable replay truth
-- §22.5 depends on. The permitted state machine is therefore enforced by the database:
--
--   PENDING -> SUCCESS      (settle, once)
--   PENDING -> TYPED_ERROR  (settle, once)
--   settled -> anything     (forbidden)

CREATE OR REPLACE FUNCTION spec001_idempotency_update_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id"
     OR NEW."scope" <> OLD."scope"
     OR NEW."commandType" <> OLD."commandType"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestFingerprint" <> OLD."requestFingerprint" THEN
    RAISE EXCEPTION 'SPEC001_IDEMPOTENCY_CLAIM_IMMUTABLE: claim identity cannot change'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Once settled, the committed outcome is historical truth and can never be rewritten,
  -- reclassified, cleared, or reset back to PENDING.
  IF OLD."outcomeKind" <> 'PENDING' THEN
    IF NEW."outcomeKind" IS DISTINCT FROM OLD."outcomeKind"
       OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
       OR NEW."commandTime" IS DISTINCT FROM OLD."commandTime" THEN
      RAISE EXCEPTION
        'SPEC001_IDEMPOTENCY_OUTCOME_IMMUTABLE: settled outcome cannot be rewritten (% -> %)',
        OLD."outcomeKind", NEW."outcomeKind"
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  -- Settling from PENDING may only reach a real terminal outcome kind.
  IF NEW."outcomeKind" NOT IN ('SUCCESS', 'TYPED_ERROR') THEN
    RAISE EXCEPTION 'SPEC001_IDEMPOTENCY_SETTLEMENT_INVALID: % is not a settled outcome kind',
      NEW."outcomeKind"
      USING ERRCODE = 'raise_exception';
  END IF;

  -- commandTime may move NULL -> one value exactly once, and is never rewritten afterwards.
  IF OLD."commandTime" IS NOT NULL AND NEW."commandTime" IS DISTINCT FROM OLD."commandTime" THEN
    RAISE EXCEPTION 'SPEC001_IDEMPOTENCY_COMMAND_TIME_SET_ONCE: commandTime cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;
