-- SPEC-001 R4 — every committed COUNTERPARTY slot is exactly pending or bound (§7).
--
-- Pending provenance is mandatory while the slot is unbound. Once bound, pendingInviteId remains
-- nullable because an already-registered counterparty is born bound with no invite provenance,
-- while a formerly pending slot preserves its immutable non-null pendingInviteId (§8.2).

ALTER TABLE "DealPartySlot"
  ADD CONSTRAINT "DealPartySlot_counterparty_state_check" CHECK (
    "slotKind" <> 'COUNTERPARTY'
    OR (
      "principalId" IS NULL
      AND "boundAt" IS NULL
      AND "pendingInviteId" IS NOT NULL
    )
    OR (
      "principalId" IS NOT NULL
      AND "boundAt" IS NOT NULL
    )
  );
