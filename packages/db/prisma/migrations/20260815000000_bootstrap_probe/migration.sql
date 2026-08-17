CREATE SCHEMA dhamani_bootstrap;

CREATE TABLE dhamani_bootstrap._migration_probe (
  sentinel TEXT PRIMARY KEY
);

INSERT INTO dhamani_bootstrap._migration_probe (sentinel)
VALUES ('SPEC-000-MIGRATION-PROBE');
