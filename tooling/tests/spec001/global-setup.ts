import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pg from 'pg';

/**
 * Provisions a dedicated database for the SPEC-001 real-PostgreSQL evidence suites.
 *
 * The SPEC-001 suites need the six tables applied, while SPEC-000's `spec000:migration:verify`
 * must still observe a genuinely clean database and apply its probe from nothing. Giving the
 * evidence suites their own database keeps both true at once and leaves the SPEC-000 migration
 * probe — and the `DATABASE_URL` it inspects — completely untouched.
 */
function evidenceDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/^\//, '')}_spec001_evidence`;
  return url.toString();
}

function maintenanceUrl(base: string): string {
  const url = new URL(base);
  url.pathname = 'postgres';
  return url.toString();
}

/**
 * Resolves the Prisma CLI entry point and runs it through Node.
 *
 * Spawning `node <cli>` rather than the `prisma`/`pnpm` shim keeps this cross-platform: a Windows
 * `.cmd` shim cannot be spawned without a shell, and `npm_execpath` is only present under
 * `pnpm run`, not under a direct vitest invocation.
 */
function runPrisma(args: readonly string[], databaseUrl: string): void {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('prisma/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.prisma;
  if (!binary) throw new Error('unable to resolve the Prisma CLI entry point');
  execFileSync(process.execPath, [join(dirname(manifestPath), binary), ...args], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 300_000,
  });
}

export default async function setup(): Promise<void> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('SPEC-001 evidence setup requires DATABASE_URL');

  const target = process.env.SPEC001_DATABASE_URL ?? evidenceDatabaseUrl(base);
  const databaseName = new URL(target).pathname.replace(/^\//, '');

  const admin = new pg.Client({ connectionString: maintenanceUrl(base) });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    // The identifier is derived from DATABASE_URL rather than user input, and is quoted anyway.
    if (existing.rowCount === 0)
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }

  // Apply the reviewed migrations with the same command production uses. `migrate deploy` is
  // idempotent, so re-running against an already-provisioned evidence database is a no-op.
  runPrisma(['migrate', 'deploy', '--schema', 'packages/db/prisma/schema.prisma'], target);

  // Direct-DB and least-privilege evidence must connect as the constrained runtime role, which
  // the migration deliberately creates NOLOGIN and without a password (no secret in migrations).
  const runtimePassword = process.env.SPEC001_RUNTIME_PASSWORD ?? 'runtime_test_only';
  const owner = new pg.Client({ connectionString: target });
  await owner.connect();
  try {
    await owner.query(
      `DO $do$ BEGIN EXECUTE format('ALTER ROLE dhamani_runtime LOGIN PASSWORD %L', $pw$${runtimePassword}$pw$); END $do$;`,
    );
  } finally {
    await owner.end();
  }

  process.env.SPEC001_DATABASE_URL = target;
  process.env.SPEC001_RUNTIME_PASSWORD = runtimePassword;
}
