import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createKernelDatabase,
  type KernelDatabase,
} from '../../../apps/api/src/spec001/database.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import {
  bornDeal,
  ownerPool,
  ports,
  randomUUID,
  requireConnectionString,
  runtimeConnectionString,
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

/**
 * Proves the container this test restarts is the PostgreSQL the application actually connects to.
 *
 * `system_identifier` is assigned at initdb and is unique per data directory, so comparing the
 * value seen over the runtime TCP URL with the value read from inside the container is a positive
 * identity match. Restarting a container that does not back the runtime URL would make the whole
 * durability claim vacuous, and on a host running several project databases that mismatch is easy
 * to create by accident.
 */
async function assertContainerBacksRuntimeUrl(pool: KernelDatabase): Promise<string> {
  const overUrl = await pool.query<{ id: string }>(
    'SELECT system_identifier::text AS id FROM pg_control_system()',
  );
  const url = new URL(requireConnectionString());
  const inside = docker(
    'exec',
    CONTAINER,
    'psql',
    '-U',
    decodeURIComponent(url.username),
    '-d',
    'postgres',
    '-tAc',
    'SELECT system_identifier::text FROM pg_control_system()',
  );
  expect(
    inside,
    `container ${CONTAINER} must back the runtime DATABASE_URL used by this evidence`,
  ).toBe(overUrl.rows[0]!.id);
  const publishedPort = docker(
    'inspect',
    '-f',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    CONTAINER,
  );
  expect(publishedPort, 'published host port must match the runtime DATABASE_URL').toBe(
    url.port || '5432',
  );
  return inside;
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

function waitForReadinessStatus(expected: number): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (probeReadiness() === expected) return;
    pause(500);
  }
  throw new Error(`application readiness did not become ${expected}`);
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
      '--require',
      './tooling/tests/spec001/node-userinfo-shim.cjs',
      '--import',
      'tsx',
      'apps/api/src/main.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DHAMANI_RUNTIME_MODE: 'test',
        // The actual service must use the constrained credential; owner/migration credentials
        // are now correctly refused by /health/ready (§24.6).
        DATABASE_URL: runtimeConnectionString(),
        TSX_TSCONFIG_PATH: 'apps/api/tsconfig.json',
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
  service.child.kill('SIGTERM');
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
    let service: ServiceHandle | undefined;
    let serviceRunning = false;
    let postgresStopAttempted = false;
    let cleanupFailure: unknown;
    try {
      // ---- 0. the container restarted below must be the one backing the runtime URL ----
      const clusterBefore = await assertContainerBacksRuntimeUrl(pool);

      // ---- 1. the real application service starts; record its process identity ----
      service = startApiService();
      serviceRunning = true;
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

      // ---- 3. PostgreSQL stops while the same real application process remains live ----
      await pool.end().catch(() => undefined);
      const startedAt = docker('inspect', '-f', '{{.State.StartedAt}}', CONTAINER);
      postgresStopAttempted = true;
      docker('stop', CONTAINER);
      expect(
        probeReadiness(),
        'the live application must fail readiness closed while PostgreSQL is stopped',
      ).toBe(503);

      // ---- 4. PostgreSQL starts again and the same application process recovers ----
      docker('start', CONTAINER);
      waitForContainerHealthy();
      const restartedAt = docker('inspect', '-f', '{{.State.StartedAt}}', CONTAINER);
      expect(restartedAt, 'PostgreSQL must genuinely have restarted').not.toBe(startedAt);
      waitForReadinessStatus(200);

      // ---- 5. the application service is actually restarted with a different PID ----
      stopApiService(service);
      serviceRunning = false;
      service = startApiService();
      serviceRunning = true;
      expect(service.pid, 'a real service restart means a new process').not.toBe(firstPid);
      expect(probeReadiness(), 'readiness healthy after recovery').toBe(200);

      // ---- 6. truth survives and is usable through the kernel boundary ----
      pool = createKernelDatabase(requireConnectionString());
      // Recovery is the same cluster that was stopped, not a different reachable PostgreSQL.
      expect(await assertContainerBacksRuntimeUrl(pool)).toBe(clusterBefore);
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
      // A failed readiness assertion must never strand the shared PostgreSQL evidence service.
      if (postgresStopAttempted) {
        try {
          docker('start', CONTAINER);
          waitForContainerHealthy();
        } catch (error) {
          cleanupFailure = error;
        }
      }
      if (service && serviceRunning) {
        try {
          stopApiService(service);
        } catch (error) {
          cleanupFailure ??= error;
        }
      }
    }
    if (cleanupFailure) throw cleanupFailure;
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
