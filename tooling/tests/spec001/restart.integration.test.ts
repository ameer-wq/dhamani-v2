import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createKernelDatabase } from '../../../apps/api/src/spec001/database.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import {
  bornDeal,
  ownerPool,
  ports,
  randomUUID,
  requireConnectionString,
  terms,
} from './helpers.ts';

/**
 * Real restart durability (E33) and §33.9.
 *
 * Both restarts are genuine and both are asserted: the application service is a separate OS
 * process whose PID must change, and the PostgreSQL container's StartedAt must change. A test
 * that silently skipped either would be false-green evidence.
 */
const CONTAINER = process.env.SPEC001_PG_CONTAINER ?? 'dhamani-spec001-pg';
const SERVICE_PORT = Number(process.env.SPEC001_SERVICE_PORT ?? 3011);

const SNAPSHOT_SQL = `SELECT d."publicReference", d."currentRevisionId", d."version",
        d."firstMutualAcceptedAt", d."sentAt", d."inviteExpiresAt",
        encode(r."integrityFingerprint",'hex') AS fingerprint,
        encode(r."termsPayloadCanonicalBytes",'hex') AS terms_bytes,
        encode(r."integrityPreimageCanonicalBytes",'hex') AS preimage_bytes
   FROM "Deal" d
   JOIN "AgreementRevision" r ON r."id" = d."currentRevisionId"
  WHERE d."id" = $1`;

type SnapshotRow = {
  publicReference: string;
  currentRevisionId: string;
  version: number;
  firstMutualAcceptedAt: Date;
  sentAt: Date;
  inviteExpiresAt: Date;
  fingerprint: string;
  terms_bytes: string;
  preimage_bytes: string;
};

const CHILD_VERIFY_SQL = `SELECT r."integrityPreimageCanonicalBytes" AS preimage,
        r."integrityFingerprint" AS fingerprint,
        d."version" AS version
   FROM "Deal" d
   JOIN "AgreementRevision" r ON r."id" = d."currentRevisionId"
  WHERE d."id" = $1`;

/** Child program run as a separate OS process; its SQL arrives through the environment. */
const CHILD_PROGRAM = [
  "import { createHash } from 'node:crypto';",
  "import pg from 'pg';",
  'const client = new pg.Client({ connectionString: process.env.SPEC001_VERIFY_URL });',
  'await client.connect();',
  'const result = await client.query(process.env.SPEC001_VERIFY_SQL, [process.env.SPEC001_VERIFY_DEAL]);',
  'await client.end();',
  'const row = result.rows[0];',
  'console.log(',
  '  JSON.stringify({',
  "    recomputed: createHash('sha256').update(row.preimage).digest('hex'),",
  "    stored: Buffer.from(row.fingerprint).toString('hex'),",
  '    version: row.version,',
  '    pid: process.pid,',
  '  }),',
  ');',
].join('\n');

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
}

function pause(ms: number): void {
  spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { timeout: ms + 5000 });
}

function waitForContainerHealthy(): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (docker('inspect', '-f', '{{.State.Health.Status}}', CONTAINER) === 'healthy') return;
    pause(1000);
  }
  throw new Error(`PostgreSQL container ${CONTAINER} did not become healthy after restart`);
}

/** Probes the running application service's readiness endpoint out-of-process. */
function probeReadiness(): number {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `fetch('http://127.0.0.1:${SERVICE_PORT}/health/ready')
         .then((r) => { process.stdout.write(String(r.status)); })
         .catch(() => { process.stdout.write('0'); });`,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return Number((probe.stdout ?? '0').trim() || '0');
}

type ServiceHandle = { child: ChildProcess; pid: number };

/**
 * Starts the real application service (the SPEC-000 API process) as a separate OS process.
 *
 * This is the actual service entry point, not a fresh in-process client: §33.9 requires a real
 * service restart, and a new object in the same Vitest process would not be one.
 */
function startApiService(): ServiceHandle {
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      // The API compiles with decorator metadata; without its own tsconfig Nest cannot bootstrap.
      '--tsconfig',
      'apps/api/tsconfig.json',
      'apps/api/src/main.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DHAMANI_RUNTIME_MODE: 'test',
        DATABASE_URL: requireConnectionString(),
        DHAMANI_PRIVATE_SENTINEL: 'spec001-service-restart-sentinel',
        PORT: String(SERVICE_PORT),
      },
      stdio: 'ignore',
    },
  );
  if (!child.pid) throw new Error('application service failed to start');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (probeReadiness() === 200) return { child, pid: child.pid };
    pause(1000);
  }
  throw new Error('application service did not become ready');
}

function stopApiService(service: ServiceHandle): void {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(service.pid), '/T', '/F'], { timeout: 30_000 });
  else service.child.kill('SIGTERM');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (probeReadiness() === 0) return;
    pause(500);
  }
  throw new Error('application service did not stop');
}

let pool = ownerPool();

afterAll(async () => {
  await pool.end().catch(() => undefined);
});

describe('SPEC-001 durability across a real restart', () => {
  it('spec001_e33_real_restart_preserves_truth', async () => {
    // ---- 1. the real application service starts; record its process identity ----
    let service = startApiService();
    const firstPid = service.pid;
    expect(probeReadiness()).toBe(200);

    // ---- 2. write real contractual truth ----
    const deal = await bornDeal(pool, { title: 'Restart durability' });
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: randomUUID(),
    });
    const successor = await proposeChanges(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      baseRevisionId: deal.revisionId,
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('Restart durability', { amended: true }),
      idempotencyKey: randomUUID(),
    });

    const before = await pool.query<SnapshotRow>(SNAPSHOT_SQL, [deal.dealId]);
    expect(before.rowCount).toBe(1);
    const snapshot = before.rows[0]!;

    // ---- 3. the application service is actually stopped ----
    stopApiService(service);
    expect(probeReadiness()).toBe(0);

    // ---- 4. PostgreSQL is actually restarted ----
    await pool.end().catch(() => undefined);
    const startedAt = docker('inspect', '-f', '{{.State.StartedAt}}', CONTAINER);
    docker('restart', CONTAINER);
    waitForContainerHealthy();
    const restartedAt = docker('inspect', '-f', '{{.State.StartedAt}}', CONTAINER);
    expect(restartedAt, 'PostgreSQL must genuinely have restarted').not.toBe(startedAt);

    // ---- 5. the application service starts again with a DIFFERENT process identity ----
    service = startApiService();
    expect(service.pid, 'a real service restart means a new process').not.toBe(firstPid);
    expect(probeReadiness(), 'readiness healthy after recovery').toBe(200);

    try {
      // ---- 6. truth survives and is usable through the kernel boundary ----
      pool = createKernelDatabase(requireConnectionString());
      const after = await pool.query<SnapshotRow>(SNAPSHOT_SQL, [deal.dealId]);
      expect(after.rowCount).toBe(1);
      const restored = after.rows[0]!;

      expect(restored.publicReference).toBe(snapshot.publicReference);
      expect(restored.currentRevisionId).toBe(successor.revisionId);
      expect(restored.version).toBe(snapshot.version);
      expect(restored.firstMutualAcceptedAt.getTime()).toBe(
        snapshot.firstMutualAcceptedAt.getTime(),
      );
      expect(restored.sentAt.getTime()).toBe(snapshot.sentAt.getTime());
      expect(restored.inviteExpiresAt.getTime()).toBe(snapshot.inviteExpiresAt.getTime());
      // Canonical BYTEA and the fingerprint survive byte-identically across both restarts.
      expect(restored.terms_bytes).toBe(snapshot.terms_bytes);
      expect(restored.preimage_bytes).toBe(snapshot.preimage_bytes);
      expect(restored.fingerprint).toBe(snapshot.fingerprint);

      // The kernel still performs contractual work after recovery.
      const accepted = await acceptCurrentRevision(pool, ports, {
        actorPrincipalId: deal.creatorId,
        correlationId: randomUUID(),
        dealId: deal.dealId,
        targetRevisionId: successor.revisionId,
        idempotencyKey: randomUUID(),
      });
      expect(accepted.agreementReady).toBe(true);
    } finally {
      stopApiService(service);
    }
  }, 600_000);

  it('spec001_restart_persistence_preserves_agreement_truth', async () => {
    const deal = await bornDeal(pool, { title: 'Cross-process durability' });
    await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: randomUUID(),
    });

    // A genuinely separate OS process reconnects and recomputes the fingerprint from the stored
    // pre-image bytes. Recomputing inside this process would not prove durability.
    const scratchDirectory = join(process.cwd(), 'evidence/results');
    mkdirSync(scratchDirectory, { recursive: true });
    const script = join(scratchDirectory, `spec001-restart-verify-${randomUUID()}.mjs`);
    writeFileSync(script, CHILD_PROGRAM);
    try {
      const child = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        timeout: 120_000,
        cwd: process.cwd(),
        env: {
          ...process.env,
          SPEC001_VERIFY_URL: requireConnectionString(),
          SPEC001_VERIFY_SQL: CHILD_VERIFY_SQL,
          SPEC001_VERIFY_DEAL: deal.dealId,
        },
      });
      expect(child.status, `${child.stdout ?? ''}${child.stderr ?? ''}`).toBe(0);
      const report = JSON.parse((child.stdout ?? '').trim()) as {
        recomputed: string;
        stored: string;
        version: number;
        pid: number;
      };
      expect(report.pid).not.toBe(process.pid);
      expect(report.recomputed).toBe(report.stored);
      expect(report.version).toBe(2);
    } finally {
      rmSync(script, { force: true });
    }
  });
});
