-- SPEC-001 runtime role and least privilege (§24.5).
--
-- The migration/DDL owner and the runtime application role are distinct roles. The runtime role
-- owns none of the six tables, is not a member of the owner role, is not a superuser, and holds
-- no TRIGGER or REFERENCES privilege — so it cannot ALTER/DROP a table, drop or disable a
-- protective trigger, drop a constraint, or take ownership.
--
-- The role is created NOLOGIN and without a password here on purpose: no credential material
-- belongs in a migration file. Granting LOGIN and setting the password is a separate operational
-- step (see tooling/scripts/spec001-runtime-role.ts), which keeps this migration secret-free.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dhamani_runtime') THEN
    CREATE ROLE dhamani_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END;
$$;

-- Start from nothing so the grants below are the complete, explicit privilege set.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dhamani_runtime;
REVOKE ALL ON SCHEMA public FROM dhamani_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO dhamani_runtime;

-- Append-only contractual history: read and append only. No UPDATE/DELETE/TRUNCATE privilege
-- exists at all, so the protective triggers are a second line of defence rather than the only one.
GRANT SELECT, INSERT ON "AgreementRevision" TO dhamani_runtime;
GRANT SELECT, INSERT ON "RevisionResponse" TO dhamani_runtime;
GRANT SELECT, INSERT ON "DealAgreementAuditEvent" TO dhamani_runtime;

-- Deal: column-level UPDATE limited to the fields SPEC-001 transitions may legitimately move.
-- publicReference, dealType, sentAt, inviteExpiresAt, createdAt and id are not updatable at all.
GRANT SELECT, INSERT ON "Deal" TO dhamani_runtime;
GRANT UPDATE (
  "currentRevisionId",
  "firstMutualAcceptedAt",
  "terminationReason",
  "terminatedAt",
  "version"
) ON "Deal" TO dhamani_runtime;

-- DealPartySlot: column-level UPDATE limited to the one-time binding fields.
GRANT SELECT, INSERT ON "DealPartySlot" TO dhamani_runtime;
GRANT UPDATE ("principalId", "boundAt") ON "DealPartySlot" TO dhamani_runtime;

-- Idempotency: claim, read, and complete the stored outcome. Nothing else.
GRANT SELECT, INSERT ON "ApplicationIdempotencyRecord" TO dhamani_runtime;
GRANT UPDATE ("outcomeKind", "outcome", "commandTime") ON "ApplicationIdempotencyRecord" TO dhamani_runtime;

-- Future tables in this schema must not silently become runtime-writable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM dhamani_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM dhamani_runtime;

-- The SPEC-000 bootstrap probe is not part of the SPEC-001 kernel and stays unreadable.
REVOKE ALL ON ALL TABLES IN SCHEMA dhamani_bootstrap FROM dhamani_runtime;
