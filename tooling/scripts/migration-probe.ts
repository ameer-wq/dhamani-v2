import pg from 'pg';
import { fail, pass } from './lib.ts';
import { execPackageManagerSync } from './package-manager.ts';

const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL is required');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const before = await client.query(
    "SELECT to_regclass('dhamani_bootstrap._migration_probe') AS probe",
  );
  if (before.rows[0]?.probe !== null) fail('probe exists before clean migration');
  const productBefore = await client.query(
    "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname <> 'public'",
  );
  if (productBefore.rows[0]?.count !== 0) fail('unexpected pre-migration objects');
} finally {
  await client.end();
}
execPackageManagerSync(['db:migrate:deploy'], { stdio: 'inherit', env: process.env });
const after = new pg.Client({ connectionString: url });
await after.connect();
try {
  const sentinel = await after.query('SELECT sentinel FROM dhamani_bootstrap._migration_probe');
  if (sentinel.rows.length !== 1 || sentinel.rows[0]?.sentinel !== 'SPEC-000-MIGRATION-PROBE')
    fail('migration sentinel mismatch');
  const history = await after.query(
    "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name='20260815000000_bootstrap_probe'",
  );
  if (
    history.rows.length !== 1 ||
    history.rows[0]?.finished_at === null ||
    history.rows[0]?.rolled_back_at !== null
  )
    fail('migration history mismatch');
  const objects = await after.query(
    "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, tablename",
  );
  const names = objects.rows.map((row) => `${String(row.schemaname)}.${String(row.tablename)}`);
  // The applied object set stays an exact allowlist: the SPEC-000 bootstrap probe plus exactly
  // the six tables the Frozen SPEC-001 contract mandates (§24). A seventh table — for example a
  // wallet or ledger table — still fails this gate closed.
  const expectedObjects = [
    'dhamani_bootstrap._migration_probe',
    'public.AgreementRevision',
    'public.ApplicationIdempotencyRecord',
    'public.Deal',
    'public.DealAgreementAuditEvent',
    'public.DealPartySlot',
    'public.RevisionResponse',
    'public._prisma_migrations',
  ];
  if (JSON.stringify(names) !== JSON.stringify(expectedObjects))
    fail(`unexpected database objects: ${JSON.stringify(names)}`);
} finally {
  await after.end();
}
execPackageManagerSync(['db:migrate:deploy'], { stdio: 'inherit', env: process.env });
const finalClient = new pg.Client({ connectionString: url });
await finalClient.connect();
const count = await finalClient.query(
  "SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='20260815000000_bootstrap_probe'",
);
await finalClient.end();
if (count.rows[0]?.count !== 1) fail('migration applied logically more than once');
pass('spec000_real_migration_probe_applies', {
  migration: '20260815000000_bootstrap_probe',
  sentinel: 'SPEC-000-MIGRATION-PROBE',
  secondDeploy: 'idempotent',
});
