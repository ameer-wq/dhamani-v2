import { execFileSync, spawnSync } from 'node:child_process';
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
 * Real restart durability (E33).
 *
 * The restart is asserted to have actually happened (the container's StartedAt must change): a
 * "restart test" that silently skipped the restart would be false-green evidence.
 */
const CONTAINER = process.env.SPEC001_PG_CONTAINER ?? 'dhamani-spec001-pg';

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

const SNAPSHOT_SQL = `SELECT d."publicReference", d."currentRevisionId", d."version",
        d."firstMutualAcceptedAt", d."sentAt", d."inviteExpiresAt",
        encode(r."integrityFingerprint",'hex') AS fingerprint,
        encode(r."termsPayloadCanonicalBytes",'hex') AS terms_bytes,
        encode(r."integrityPreimageCanonicalBytes",'hex') AS preimage_bytes
   FROM "Deal" d
   JOIN "AgreementRevision" r ON r."id" = d."currentRevisionId"
  WHERE d."id" = $1`;

const CHILD_VERIFY_SQL = `SELECT r."integrityPreimageCanonicalBytes" AS preimage,
        r."integrityFingerprint" AS fingerprint,
        d."version" AS version
   FROM "Deal" d
   JOIN "AgreementRevision" r ON r."id" = d."currentRevisionId"
  WHERE d."id" = $1`;

/**
 * Child program run as a separate OS process. Its SQL arrives through the environment so the
 * generated file contains no nested quoting.
 */
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

function waitForHealthy(): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = docker('inspect', '-f', '{{.State.Health.Status}}', CONTAINER);
    if (status === 'healthy') return;
    // Blocking pause via a child process keeps this wait synchronous and deterministic.
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 5000 });
  }
  throw new Error(`PostgreSQL container ${CONTAINER} did not become healthy after restart`);
}

let pool = ownerPool();

afterAll(async () => {
  await pool.end().catch(() => undefined);
});

describe('SPEC-001 durability across a real restart', () => {
  it('spec001_e33_real_restart_preserves_truth', async () => {
    // ---- write real contractual truth before the restart ----
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

    // ---- real PostgreSQL restart ----
    await pool.end().catch(() => undefined);
    const startedAt = docker('inspect', '-f', '{{.State.StartedAt}}', CONTAINER);
    docker('restart', CONTAINER);
    waitForHealthy();
    const restartedAt = docker('inspect', '-f', '{{.State.StartedAt}}', CONTAINER);
    expect(restartedAt).not.toBe(startedAt);

    // ---- reconnect with a fresh pool and re-verify ----
    pool = createKernelDatabase(requireConnectionString());
    const after = await pool.query<SnapshotRow>(SNAPSHOT_SQL, [deal.dealId]);
    expect(after.rowCount).toBe(1);
    const restored = after.rows[0]!;

    expect(restored.publicReference).toBe(snapshot.publicReference);
    expect(restored.currentRevisionId).toBe(successor.revisionId);
    expect(restored.version).toBe(snapshot.version);
    expect(restored.firstMutualAcceptedAt.getTime()).toBe(snapshot.firstMutualAcceptedAt.getTime());
    expect(restored.sentAt.getTime()).toBe(snapshot.sentAt.getTime());
    expect(restored.inviteExpiresAt.getTime()).toBe(snapshot.inviteExpiresAt.getTime());
    // Canonical BYTEA and the fingerprint survive byte-identically across the restart.
    expect(restored.terms_bytes).toBe(snapshot.terms_bytes);
    expect(restored.preimage_bytes).toBe(snapshot.preimage_bytes);
    expect(restored.fingerprint).toBe(snapshot.fingerprint);

    // The kernel still works after reconnect.
    const accepted = await acceptCurrentRevision(pool, ports, {
      actorPrincipalId: deal.creatorId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: successor.revisionId,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.agreementReady).toBe(true);
  });

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
    // pre-image bytes. Recomputing inside this process would not prove durability. The script is
    // written inside the repository (gitignored evidence/results) so Node resolves `pg` from the
    // project's own node_modules.
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
      // Byte-identical recompute in a genuinely different OS process.
      expect(report.pid).not.toBe(process.pid);
      expect(report.recomputed).toBe(report.stored);
      expect(report.version).toBe(2);
    } finally {
      rmSync(script, { force: true });
    }
  });
});
