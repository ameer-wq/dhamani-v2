import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  SPEC001_TABLES,
  evaluateRuntimeRoleReadiness,
} from '../../../packages/domain/src/index.ts';
import {
  assertContractualWriteReadiness,
  collectRuntimeRoleFacts,
} from '../../../apps/api/src/spec001/readiness.ts';
import {
  createKernelDatabase,
  driverFailureOf,
  isRetryableDatabaseError,
  mapDatabaseError,
  Spec001PersistenceFailure,
  type KernelDatabase,
} from '../../../apps/api/src/spec001/database.ts';
import { uuidV7 } from '../../../apps/api/src/spec001/crypto.ts';
import { acceptCurrentRevision } from '../../../apps/api/src/spec001/commands/accept-current-revision.ts';
import { createFormalDeal } from '../../../apps/api/src/spec001/commands/create-formal-deal.ts';
import { proposeChanges } from '../../../apps/api/src/spec001/commands/propose-changes.ts';
import {
  bornDeal,
  dealRow,
  errorCodeOf,
  ownerPool,
  ports,
  randomUUID,
  requireConnectionString,
  runtimeConnectionString,
  terms,
} from './helpers.ts';

const owner = ownerPool();
let runtime: KernelDatabase;

const APPEND_ONLY_TABLES = ['AgreementRevision', 'RevisionResponse', 'DealAgreementAuditEvent'];
const READINESS_PORT = 3013;

async function probeReadiness(): Promise<number> {
  try {
    return (await fetch(`http://127.0.0.1:${READINESS_PORT}/health/ready`)).status;
  } catch {
    return 0;
  }
}

async function startRealApiForReadiness(
  databaseUrl: string,
  expectedStatus: 200 | 503,
): Promise<ChildProcess> {
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
        DATABASE_URL: databaseUrl,
        TSX_TSCONFIG_PATH: 'apps/api/tsconfig.json',
        DHAMANI_PRIVATE_SENTINEL: 'spec001-real-readiness-sentinel',
        PORT: String(READINESS_PORT),
      },
      stdio: 'ignore',
    },
  );
  if (!child.pid) throw new Error('real application readiness process failed to start');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await probeReadiness()) === expectedStatus) return child;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`real application readiness did not reach HTTP ${expectedStatus}`);
}

async function stopRealApi(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await probeReadiness()) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error('real application readiness process did not stop');
}

beforeAll(async () => {
  // The runtime role is created NOLOGIN by the migration; evidence needs a real login for it.
  await owner.query(
    `DO $$ BEGIN
       EXECUTE format('ALTER ROLE dhamani_runtime LOGIN PASSWORD %L', 'runtime_test_only');
     END $$;`,
  );
  runtime = createKernelDatabase(runtimeConnectionString());
});

afterAll(async () => {
  await runtime?.end();
  await owner.end();
});

/** Runs a statement as the constrained runtime role and returns the error message, if any. */
async function runtimeAttack(statement: string, values: unknown[] = []): Promise<string> {
  const client = await runtime.connect();
  try {
    await client.query(statement, values);
    return 'NO_ERROR_THROWN';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.release();
  }
}

async function ownerAttack(statement: string, values: unknown[] = []): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(statement, values);
    await client.query('COMMIT');
    return 'NO_ERROR_THROWN';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.release();
  }
}

function reference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const group = (): string =>
    Array.from({ length: 4 }, () => alphabet.charAt(Math.floor(Math.random() * 32))).join('');
  return `DH-${group()}-${group()}-${group()}`;
}

describe('SPEC-001 direct-SQL protections as the real runtime role', () => {
  it('spec001_runtime_connection_role_is_nonowner_least_privilege', async () => {
    const facts = await collectRuntimeRoleFacts(runtime);
    // The probe must actually be running as the constrained role, not as owner.
    expect(facts.currentUser).toBe('dhamani_runtime');
    expect(facts.isSuperuser).toBe(false);
    expect(facts.isMemberOfOwnerRole).toBe(false);
    expect(facts.ownedTables).toEqual([]);
    expect(facts.heldDeniedPrivileges).toEqual([]);
    expect(facts.canBypassTriggers).toBe(false);
    expect([...facts.observedTables].sort()).toEqual([...SPEC001_TABLES].sort());

    const verdict = await assertContractualWriteReadiness(runtime);
    expect(verdict.healthy).toBe(true);
    expect(verdict.failures).toEqual([]);

    // Required negative configuration: supplying the owner/migration credential as the runtime
    // connection must flip readiness unhealthy, so a stricter CI fixture cannot mask an unsafe
    // production DATABASE_URL.
    const ownerVerdict = await assertContractualWriteReadiness(owner);
    expect(ownerVerdict.healthy).toBe(false);
    expect(ownerVerdict.failures.some((failure) => failure.includes('OWNS_TABLE'))).toBe(true);
    expect(ownerVerdict.failures).toContain('RUNTIME_CREDENTIAL_IS_SUPERUSER');

    // A probe that observed nothing must not look identical to a clean result.
    const blindVerdict = evaluateRuntimeRoleReadiness({
      currentUser: 'dhamani_runtime',
      isSuperuser: false,
      isMemberOfOwnerRole: false,
      ownedTables: [],
      heldDeniedPrivileges: [],
      canBypassTriggers: false,
      observedTables: [],
    });
    expect(blindVerdict.healthy).toBe(false);
    expect(blindVerdict.failures).toHaveLength(SPEC001_TABLES.length);

    // Exercise the actual service entry point and /health/ready dependency, not a mocked verdict:
    // the owner credential is reachable but unhealthy, while the constrained credential is ready.
    let service = await startRealApiForReadiness(requireConnectionString(), 503);
    try {
      expect(await probeReadiness()).toBe(503);
    } finally {
      await stopRealApi(service);
    }
    service = await startRealApiForReadiness(runtimeConnectionString(), 200);
    try {
      expect(await probeReadiness()).toBe(200);
    } finally {
      await stopRealApi(service);
    }

    // A reachable, safe credential is not enough: the production readiness route must also
    // fail closed when a fresh connection to that credential's PostgreSQL endpoint cannot be
    // established. Port 1 is deliberately unreachable; this still exercises the real app,
    // controller, readiness evaluator, Prisma adapter, and PostgreSQL driver without a mock.
    const unavailableRuntimeUrl = new URL(runtimeConnectionString());
    unavailableRuntimeUrl.hostname = '127.0.0.1';
    unavailableRuntimeUrl.port = '1';
    service = await startRealApiForReadiness(unavailableRuntimeUrl.toString(), 503);
    try {
      expect(await probeReadiness()).toBe(503);
    } finally {
      await stopRealApi(service);
    }
  });

  it('spec001_e28_append_only_runtime_role_bypass_attacks', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      expect(await runtimeAttack(`UPDATE "${table}" SET "id" = "id"`)).toMatch(
        /permission denied/i,
      );
      expect(await runtimeAttack(`DELETE FROM "${table}"`)).toMatch(/permission denied/i);
      expect(await runtimeAttack(`TRUNCATE TABLE "${table}"`)).toMatch(/permission denied/i);
      // Disabling or dropping the protection must fail at the DDL/ALTER step itself.
      expect(await runtimeAttack(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`)).toMatch(
        /must be owner|permission denied/i,
      );
      expect(
        await runtimeAttack(`ALTER TABLE "${table}" DISABLE TRIGGER "${table}_no_update"`),
      ).toMatch(/must be owner|permission denied/i);
      expect(await runtimeAttack(`DROP TRIGGER "${table}_no_update" ON "${table}"`)).toMatch(
        /must be owner/i,
      );
      expect(await runtimeAttack(`ALTER TABLE "${table}" OWNER TO dhamani_runtime`)).toMatch(
        /must be owner/i,
      );
      expect(await runtimeAttack(`DROP TABLE "${table}"`)).toMatch(/must be owner/i);
    }

    // The session_replication_role trigger-bypass route is closed to this credential.
    expect(await runtimeAttack(`SET session_replication_role = 'replica'`)).toMatch(
      /permission denied/i,
    );
    // And the runtime role cannot create objects to work around the schema at all.
    expect(await runtimeAttack('CREATE TABLE runtime_escape (x int)')).toMatch(
      /permission denied/i,
    );

    // Deal/DealPartySlot are covered by the same DDL-bypass prohibition.
    for (const table of ['Deal', 'DealPartySlot']) {
      expect(await runtimeAttack(`DELETE FROM "${table}"`)).toMatch(/permission denied/i);
      expect(await runtimeAttack(`TRUNCATE TABLE "${table}"`)).toMatch(/permission denied/i);
      expect(await runtimeAttack(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`)).toMatch(
        /must be owner|permission denied/i,
      );
    }

    // Column-level least privilege: identity/timer columns are not updatable at all.
    expect(await runtimeAttack(`UPDATE "Deal" SET "publicReference"='DH-2222-3333-4444'`)).toMatch(
      /permission denied/i,
    );
    expect(await runtimeAttack(`UPDATE "Deal" SET "sentAt"=now()`)).toMatch(/permission denied/i);
    expect(await runtimeAttack(`UPDATE "DealPartySlot" SET "role"='SELLER'`)).toMatch(
      /permission denied/i,
    );
  });

  it('spec001_revision_rejects_update_delete_truncate_direct_sql', async () => {
    const deal = await bornDeal(owner);
    // Even as the table owner — a strictly stronger credential than the runtime role — the
    // append-only triggers reject mutation of contractual history.
    expect(
      await ownerAttack(
        `UPDATE "AgreementRevision" SET "termsSchemaId"='tampered' WHERE "dealId"=$1`,
        [deal.dealId],
      ),
    ).toMatch(/SPEC001_APPEND_ONLY_VIOLATION/);
    expect(
      await ownerAttack(`DELETE FROM "AgreementRevision" WHERE "dealId"=$1`, [deal.dealId]),
    ).toMatch(/SPEC001_APPEND_ONLY_VIOLATION/);
    expect(await ownerAttack('TRUNCATE TABLE "DealAgreementAuditEvent"')).toMatch(
      /SPEC001_TRUNCATE_FORBIDDEN/,
    );
    expect(
      await ownerAttack(`UPDATE "RevisionResponse" SET "responseKind"='REJECT' WHERE "dealId"=$1`, [
        deal.dealId,
      ]),
    ).toMatch(/SPEC001_APPEND_ONLY_VIOLATION/);
  });

  it('spec001_e29_participant_db_attacks', async () => {
    const deal = await bornDeal(owner);

    // A third slot cannot be added.
    expect(
      await ownerAttack(
        `INSERT INTO "DealPartySlot"
           ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
         VALUES ($1,$2,'GOODS','COUNTERPARTY','SELLER',$3,NULL,now(),now())`,
        [uuidV7(), deal.dealId, randomUUID()],
      ),
    ).toMatch(/DealPartySlot_deal_slotKind_key/);

    // Slot deletion is forbidden.
    expect(
      await ownerAttack(`DELETE FROM "DealPartySlot" WHERE "dealId"=$1`, [deal.dealId]),
    ).toMatch(/SPEC001_APPEND_ONLY_VIOLATION/);

    // Identity replacement is forbidden, and disabling the guard first must fail at the ALTER
    // step when attempted by the runtime role.
    expect(
      await ownerAttack(`UPDATE "DealPartySlot" SET "principalId"=$1 WHERE "dealId"=$2`, [
        randomUUID(),
        deal.dealId,
      ]),
    ).toMatch(/SPEC001_SLOT_PRINCIPAL_SET_ONCE/);
    expect(
      await runtimeAttack(
        'ALTER TABLE "DealPartySlot" DISABLE TRIGGER "DealPartySlot_update_guard"',
      ),
    ).toMatch(/must be owner|permission denied/i);
    const identityAfterFailedDisable = await owner.query<{ principalId: string }>(
      `SELECT "principalId" AS "principalId" FROM "DealPartySlot"
        WHERE "dealId"=$1 AND "slotKind"='CREATOR'`,
      [deal.dealId],
    );
    expect(identityAfterFailedDisable.rows[0]!.principalId).toBe(deal.creatorId);

    // Same Principal attack in the named E29 identity: start from a legitimate pending slot so
    // the intended same-Principal UNIQUE constraint — not the immutable replacement trigger — is
    // the rule that rejects the attempted bind.
    const pendingInviteId = randomUUID();
    const pendingCreator = randomUUID();
    const pending = await createFormalDeal(owner, ports, {
      actorPrincipalId: pendingCreator,
      correlationId: randomUUID(),
      dealType: 'GOODS',
      creatorRole: 'BUYER',
      counterpartyTarget: { kind: 'PENDING_INVITE', pendingInviteId },
      termsSchemaId: 'dhamani.goods.v1',
      rawTerms: terms('E29 same principal'),
      idempotencyKey: randomUUID(),
    });
    expect(
      await ownerAttack(
        `UPDATE "DealPartySlot" SET "principalId"=$1,"boundAt"=clock_timestamp()
          WHERE "dealId"=$2 AND "slotKind"='COUNTERPARTY'`,
        [pendingCreator, pending.dealId],
      ),
    ).toMatch(/DealPartySlot_deal_principal_key/);

    // Role/type drift is impossible.
    expect(
      await ownerAttack(`UPDATE "DealPartySlot" SET "role"='CLIENT' WHERE "dealId"=$1`, [
        deal.dealId,
      ]),
    ).toMatch(/SPEC001_SLOT_IMMUTABLE/);
    // Construct a fresh birth-shaped transaction whose only malformed row is the role/type
    // triple. This cannot pass accidentally because of a duplicate slot or parent FK.
    const mismatchDeal = uuidV7();
    const mismatchRevision = uuidV7();
    expect(
      await ownerAttack(
        `WITH d AS (
           INSERT INTO "Deal" ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt","version","createdAt")
           VALUES ($1,$2,'GOODS',$3,now(),now()+interval '168 hours',1,now())
         ), r AS (
           INSERT INTO "AgreementRevision"
             ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint","createdAt")
           VALUES ($3,$1,1,NULL,$4,'dhamani.goods.v1','{}'::bytea,'{}'::bytea,decode(repeat('ab',32),'hex'),now())
         )
         INSERT INTO "DealPartySlot"
           ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
         VALUES ($5,$1,'GOODS','CREATOR','BUYER',$4,NULL,now(),now()),
                ($6,$1,'GOODS','COUNTERPARTY','CLIENT',$7,NULL,now(),now())`,
        [
          mismatchDeal,
          reference(),
          mismatchRevision,
          randomUUID(),
          uuidV7(),
          uuidV7(),
          randomUUID(),
        ],
      ),
    ).toMatch(/DealPartySlot_role_triple_check/);

    // Every post-birth slot identity/role/type drift is rejected by the dedicated slot guard.
    for (const [field, statement] of [
      ['dealType', `UPDATE "DealPartySlot" SET "dealType"='SERVICES' WHERE "dealId"=$1`],
      [
        'slotKind',
        `UPDATE "DealPartySlot" SET "slotKind"='COUNTERPARTY' WHERE "dealId"=$1 AND "slotKind"='CREATOR'`,
      ],
      [
        'role',
        `UPDATE "DealPartySlot" SET "role"='SELLER' WHERE "dealId"=$1 AND "slotKind"='CREATOR'`,
      ],
    ] as const) {
      expect(await ownerAttack(statement, [deal.dealId]), field).toMatch(/SPEC001_SLOT_IMMUTABLE/);
    }

    // A COUNTERPARTY with no Principal and no opaque pendingInviteId is not a committed state.
    const invalidStateDeal = uuidV7();
    const invalidStateRevision = uuidV7();
    expect(
      await ownerAttack(
        `WITH d AS (
           INSERT INTO "Deal" ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt","version","createdAt")
           VALUES ($1,$2,'GOODS',$3,now(),now()+interval '168 hours',1,now())
         ), r AS (
           INSERT INTO "AgreementRevision"
             ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint","createdAt")
           VALUES ($3,$1,1,NULL,$4,'dhamani.goods.v1','{}'::bytea,'{}'::bytea,decode(repeat('ab',32),'hex'),now())
         )
         INSERT INTO "DealPartySlot"
           ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
         VALUES ($5,$1,'GOODS','CREATOR','BUYER',$4,NULL,now(),now()),
                ($6,$1,'GOODS','COUNTERPARTY','SELLER',NULL,NULL,now(),NULL)`,
        [invalidStateDeal, reference(), invalidStateRevision, randomUUID(), uuidV7(), uuidV7()],
      ),
    ).toMatch(/DealPartySlot_counterparty_state_check/);

    // Explicit ONE-slot probe: a Deal committing with exactly one slot must be rejected by the
    // deferred exactly-two-slots protection (the zero-slot probe follows).
    const oneSlotDeal = uuidV7();
    const oneSlotRevision = uuidV7();
    expect(
      await ownerAttack(
        `WITH d AS (
           INSERT INTO "Deal" ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt","version","createdAt")
           VALUES ($1,$2,'GOODS',$3, now(), now() + interval '168 hours', 1, now())
         ), r AS (
           INSERT INTO "AgreementRevision"
             ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint","createdAt")
           VALUES ($3,$1,1,NULL,$4,'dhamani.goods.v1','{}'::bytea,'{}'::bytea,decode(repeat('ab',32),'hex'),now())
         )
         INSERT INTO "DealPartySlot"
           ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
         VALUES ($5,$1,'GOODS','CREATOR','BUYER',$4,NULL,now(),now())`,
        [oneSlotDeal, reference(), oneSlotRevision, randomUUID(), uuidV7()],
      ),
    ).toMatch(/SPEC001_DEAL_REQUIRES_EXACTLY_TWO_SLOTS/);
    const oneSlotRows = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "Deal" WHERE "id"=$1`,
      [oneSlotDeal],
    );
    expect(oneSlotRows.rows[0]!.count).toBe(0);

    // A Deal with fewer than two slots cannot commit.
    const lonelyDeal = uuidV7();
    const lonelyRevision = uuidV7();
    expect(
      await ownerAttack(
        `WITH d AS (
           INSERT INTO "Deal" ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt","version","createdAt")
           VALUES ($1,$2,'GOODS',$3, now(), now() + interval '168 hours', 1, now())
         )
         INSERT INTO "AgreementRevision"
           ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint","createdAt")
         VALUES ($3,$1,1,NULL,$4,'dhamani.goods.v1','{}'::bytea,'{}'::bytea,decode(repeat('ab',32),'hex'),now())`,
        [lonelyDeal, reference(), lonelyRevision, randomUUID()],
      ),
    ).toMatch(/SPEC001_DEAL_REQUIRES_EXACTLY_TWO_SLOTS/);
  });

  it('spec001_e30_current_revision_cross_deal_corruption', async () => {
    const dealA = await bornDeal(owner);
    const dealB = await bornDeal(owner);

    // Pointing one Deal at another Deal's revision violates the composite deferred FK.
    expect(
      await ownerAttack(
        `UPDATE "Deal" SET "version"="version"+1, "currentRevisionId"=$1 WHERE "id"=$2`,
        [dealA.revisionId, dealB.dealId],
      ),
    ).toMatch(/Deal_currentRevision_same_deal_fkey/);

    // A NULL current revision is impossible at the column level.
    expect(
      await ownerAttack(
        `UPDATE "Deal" SET "version"="version"+1, "currentRevisionId"=NULL WHERE "id"=$1`,
        [dealB.dealId],
      ),
    ).toMatch(/null value in column/i);

    // A Deal whose currentRevisionId never exists cannot commit.
    expect(
      await ownerAttack(
        `INSERT INTO "Deal" ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt","version","createdAt")
         VALUES ($1,$2,'GOODS',$3, now(), now() + interval '168 hours', 1, now())`,
        [uuidV7(), reference(), uuidV7()],
      ),
    ).toMatch(/Deal_currentRevision_same_deal_fkey|SPEC001_DEAL_REQUIRES_EXACTLY_TWO_SLOTS/);
  });

  it('spec001_e26_cross_deal_revision_abuse', async () => {
    const dealA = await bornDeal(owner);
    const dealB = await bornDeal(owner);

    // Cross-Deal caller target and successor base fail through the real application command path.
    expect(
      await errorCodeOf(() =>
        acceptCurrentRevision(owner, ports, {
          actorPrincipalId: dealB.counterpartyId,
          correlationId: randomUUID(),
          dealId: dealB.dealId,
          targetRevisionId: dealA.revisionId,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).toBe('REVISION_NOT_FOUND');
    expect(
      await errorCodeOf(() =>
        proposeChanges(owner, ports, {
          actorPrincipalId: dealB.counterpartyId,
          correlationId: randomUUID(),
          dealId: dealB.dealId,
          baseRevisionId: dealA.revisionId,
          termsSchemaId: 'dhamani.goods.v1',
          rawTerms: terms('E26 cross Deal base', { attempt: true }),
          idempotencyKey: randomUUID(),
        }),
      ),
    ).toBe('REVISION_NOT_FOUND');

    // A response cannot reference another Deal's revision.
    expect(
      await ownerAttack(
        `INSERT INTO "RevisionResponse" ("id","dealId","revisionId","principalId","responseKind","responseOrigin","createdAt")
         VALUES ($1,$2,$3,$4,'ACCEPT','EXPLICIT',now())`,
        [uuidV7(), dealB.dealId, dealA.revisionId, dealB.counterpartyId],
      ),
    ).toMatch(/RevisionResponse_revision_fkey/);

    // A responder who is not a bound slot of that Deal is rejected.
    expect(
      await ownerAttack(
        `INSERT INTO "RevisionResponse" ("id","dealId","revisionId","principalId","responseKind","responseOrigin","createdAt")
         VALUES ($1,$2,$3,$4,'ACCEPT','EXPLICIT',now())`,
        [uuidV7(), dealB.dealId, dealB.revisionId, randomUUID()],
      ),
    ).toMatch(/RevisionResponse_party_fkey/);

    // A successor cannot chain to a predecessor in a different Deal.
    expect(
      await ownerAttack(
        `INSERT INTO "AgreementRevision"
           ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint","createdAt")
         VALUES ($1,$2,2,$3,$4,'dhamani.goods.v1','{}'::bytea,'{}'::bytea,decode(repeat('cd',32),'hex'),now())`,
        [uuidV7(), dealB.dealId, dealA.revisionId, dealB.counterpartyId],
      ),
    ).toMatch(/AgreementRevision_predecessor_same_deal_fkey/);

    // Deal.currentRevisionId cannot be redirected to another Deal's revision.
    expect(
      await ownerAttack(
        `UPDATE "Deal" SET "version"="version"+1,"currentRevisionId"=$1 WHERE "id"=$2`,
        [dealA.revisionId, dealB.dealId],
      ),
    ).toMatch(/Deal_currentRevision_same_deal_fkey/);

    // All four abuse surfaces rolled back completely.
    expect((await dealRow(owner, dealA.dealId)).version).toBe(1);
    expect((await dealRow(owner, dealB.dealId)).version).toBe(1);
  });

  it('spec001_e31_birth_failure_injection_matrix', async () => {
    // Frozen E31 requires a real failure after EVERY birth stage, including the audit and
    // idempotency stages, with zero partial committed truth afterwards. The failures are
    // injected into the real CreateFormalDeal transaction with test-only triggers keyed on a
    // sentinel public reference, so the production path carries no test hook.
    const FAULT_STAGES = [
      'deal',
      'revision',
      'slot1',
      'slot2',
      'response',
      'audit',
      'idempotency',
    ] as const;

    await owner.query(
      'CREATE TABLE IF NOT EXISTS spec001_test_birth_fault (marker text primary key, stage text not null)',
    );

    // Each trigger fires only for the sentinel Deal and only for its declared stage.
    const install = async (table: string, name: string, body: string) => {
      await owner.query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS TRIGGER
          LANGUAGE plpgsql AS $fn$
          DECLARE target text;
          BEGIN
            ${body}
            RETURN NEW;
          END; $fn$;`);
      await owner.query(
        `CREATE OR REPLACE TRIGGER "${name}_trg" BEFORE INSERT OR UPDATE ON "${table}"
             FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      await owner.query(`ALTER TABLE "${table}" ENABLE ALWAYS TRIGGER "${name}_trg"`);
    };

    const dealScoped = (stage: string) => `
        SELECT f.stage INTO target FROM spec001_test_birth_fault f
          JOIN "Deal" d ON d."publicReference" = f.marker
         WHERE d."id" = NEW."dealId" AND f.stage = '${stage}';
        IF target IS NOT NULL THEN
          RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_${stage}' USING ERRCODE = 'raise_exception';
        END IF;`;

    try {
      await install('AgreementRevision', 'spec001_test_fault_revision', dealScoped('deal'));
      await install(
        'DealPartySlot',
        'spec001_test_fault_slot',
        `SELECT f.stage INTO target FROM spec001_test_birth_fault f
             JOIN "Deal" d ON d."publicReference" = f.marker
            WHERE d."id" = NEW."dealId"
              AND ((f.stage = 'revision' AND NEW."slotKind" = 'CREATOR')
                OR (f.stage = 'slot1' AND NEW."slotKind" = 'COUNTERPARTY'));
           IF target IS NOT NULL THEN
             RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_slot' USING ERRCODE = 'raise_exception';
           END IF;`,
      );
      await install('RevisionResponse', 'spec001_test_fault_response', dealScoped('slot2'));
      await install('DealAgreementAuditEvent', 'spec001_test_fault_audit', dealScoped('response'));
      await install(
        'ApplicationIdempotencyRecord',
        'spec001_test_fault_idempotency',
        `SELECT f.stage INTO target FROM spec001_test_birth_fault f
            WHERE f.marker = NEW."idempotencyKey" AND f.stage = 'audit';
           IF target IS NOT NULL AND NEW."outcomeKind" <> 'PENDING' THEN
             RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_audit' USING ERRCODE = 'raise_exception';
           END IF;`,
      );
      // The final stage fails at COMMIT, after every statement has already succeeded.
      await owner.query(`CREATE OR REPLACE FUNCTION spec001_test_fault_commit() RETURNS TRIGGER
          LANGUAGE plpgsql AS $fn$
          DECLARE target text;
          BEGIN
            SELECT f.stage INTO target FROM spec001_test_birth_fault f
             WHERE f.marker = NEW."publicReference" AND f.stage = 'idempotency';
            IF target IS NOT NULL THEN
              RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_commit' USING ERRCODE = 'raise_exception';
            END IF;
            RETURN NULL;
          END; $fn$;`);
      // A deferred check must be a CONSTRAINT TRIGGER, which has no CREATE OR REPLACE form.
      await owner
        .query('DROP TRIGGER IF EXISTS "spec001_test_fault_commit_trg" ON "Deal"')
        .catch(() => undefined);
      await owner.query(
        `CREATE CONSTRAINT TRIGGER "spec001_test_fault_commit_trg" AFTER INSERT ON "Deal"
             DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
             EXECUTE FUNCTION spec001_test_fault_commit()`,
      );

      for (const stage of FAULT_STAGES) {
        const marker = reference();
        const idempotencyKey = randomUUID();
        const actorPrincipalId = randomUUID();
        // The idempotency-stage trigger keys on the caller key rather than the reference.
        await owner.query('INSERT INTO spec001_test_birth_fault (marker, stage) VALUES ($1,$2)', [
          stage === 'audit' ? idempotencyKey : marker,
          stage,
        ]);

        // A fixed reference generator makes the sentinel deterministic; every other id still
        // comes from the real production port.
        const sentinelPorts = { ...ports, newPublicReference: () => marker };

        let failed = false;
        try {
          await createFormalDeal(owner, sentinelPorts, {
            actorPrincipalId,
            correlationId: randomUUID(),
            dealType: 'GOODS',
            creatorRole: 'BUYER',
            counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms: terms(`Birth failure ${stage}`),
            idempotencyKey,
          });
        } catch {
          failed = true;
        }
        expect(failed, `stage ${stage} must fail`).toBe(true);

        // ZERO partial committed truth across all six SPEC-001 tables.
        const residue = await owner.query<{
          deals: number;
          revisions: number;
          slots: number;
          responses: number;
          events: number;
          claims: number;
        }>(
          `SELECT
               (SELECT count(*)::int FROM "Deal" WHERE "publicReference"=$1) AS deals,
               (SELECT count(*)::int FROM "AgreementRevision" r
                  JOIN "Deal" d ON d."id"=r."dealId" WHERE d."publicReference"=$1) AS revisions,
               (SELECT count(*)::int FROM "DealPartySlot" s
                  JOIN "Deal" d ON d."id"=s."dealId" WHERE d."publicReference"=$1) AS slots,
               (SELECT count(*)::int FROM "RevisionResponse" p
                  JOIN "Deal" d ON d."id"=p."dealId" WHERE d."publicReference"=$1) AS responses,
               (SELECT count(*)::int FROM "DealAgreementAuditEvent" a
                  JOIN "Deal" d ON d."id"=a."dealId" WHERE d."publicReference"=$1) AS events,
               (SELECT count(*)::int FROM "ApplicationIdempotencyRecord"
                  WHERE "idempotencyKey"=$2) AS claims`,
          [marker, idempotencyKey],
        );
        expect(residue.rows[0], `stage ${stage} left partial truth`).toEqual({
          deals: 0,
          revisions: 0,
          slots: 0,
          responses: 0,
          events: 0,
          claims: 0,
        });

        await owner.query('DELETE FROM spec001_test_birth_fault');
      }

      // With no fault configured the very same path commits normally, proving the matrix was
      // failing for the injected reason and not because the path was broken.
      const healthy = await createFormalDeal(owner, ports, {
        actorPrincipalId: randomUUID(),
        correlationId: randomUUID(),
        dealType: 'GOODS',
        creatorRole: 'BUYER',
        counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
        termsSchemaId: 'dhamani.goods.v1',
        rawTerms: terms('Birth failure control'),
        idempotencyKey: randomUUID(),
      });
      expect(healthy.replayed).toBe(false);
    } finally {
      for (const [table, name] of [
        ['AgreementRevision', 'spec001_test_fault_revision'],
        ['DealPartySlot', 'spec001_test_fault_slot'],
        ['RevisionResponse', 'spec001_test_fault_response'],
        ['DealAgreementAuditEvent', 'spec001_test_fault_audit'],
        ['ApplicationIdempotencyRecord', 'spec001_test_fault_idempotency'],
      ] as const) {
        await owner
          .query(`DROP TRIGGER IF EXISTS "${name}_trg" ON "${table}"`)
          .catch(() => undefined);
        await owner.query(`DROP FUNCTION IF EXISTS ${name}()`).catch(() => undefined);
      }
      await owner
        .query('DROP TRIGGER IF EXISTS "spec001_test_fault_commit_trg" ON "Deal"')
        .catch(() => undefined);
      await owner
        .query('DROP FUNCTION IF EXISTS spec001_test_fault_commit()')
        .catch(() => undefined);
      await owner.query('DROP TABLE IF EXISTS spec001_test_birth_fault').catch(() => undefined);
    }
  }, 300_000);
  it('spec001_settled_idempotency_outcome_is_immutable', async () => {
    // The runtime role legitimately holds column-level UPDATE on (outcomeKind, outcome,
    // commandTime) so it can settle its own claim. Without a DB state machine that same grant
    // would let it rewrite historical replay truth after commit (§22.5, E42).
    const deal = await bornDeal(owner, { title: 'Settled outcome immutability' });
    const acceptKey = randomUUID();
    const accepted = await acceptCurrentRevision(owner, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });

    const stored = await owner.query<{
      id: string;
      outcomeKind: string;
      outcome: Record<string, unknown>;
      commandTime: Date;
    }>(
      `SELECT "id","outcomeKind","outcome","commandTime" FROM "ApplicationIdempotencyRecord"
        WHERE "idempotencyKey"=$1`,
      [acceptKey],
    );
    expect(stored.rowCount).toBe(1);
    const record = stored.rows[0]!;
    // 1. The legitimate PENDING -> settled transition already worked.
    expect(record.outcomeKind).toBe('SUCCESS');
    expect(record.outcome.resultKind).toBe('FIRST_MUTUAL_ACCEPTANCE_REACHED');

    // 2-5. Every post-settlement rewrite attempted as the constrained runtime credential must
    // fail at the database protection step.
    const tampering: Array<[string, string, unknown[]]> = [
      [
        'rewrite stored outcome json',
        `UPDATE "ApplicationIdempotencyRecord" SET "outcome"='{"tampered":true}'::jsonb WHERE "id"=$1`,
        [record.id],
      ],
      [
        'reclassify SUCCESS -> TYPED_ERROR',
        `UPDATE "ApplicationIdempotencyRecord" SET "outcomeKind"='TYPED_ERROR' WHERE "id"=$1`,
        [record.id],
      ],
      [
        'reset settlement back to PENDING',
        `UPDATE "ApplicationIdempotencyRecord" SET "outcomeKind"='PENDING' WHERE "id"=$1`,
        [record.id],
      ],
      [
        'rewrite the authoritative command time',
        `UPDATE "ApplicationIdempotencyRecord" SET "commandTime"=now() WHERE "id"=$1`,
        [record.id],
      ],
      [
        'rewrite kind and outcome together',
        `UPDATE "ApplicationIdempotencyRecord" SET "outcomeKind"='TYPED_ERROR', "outcome"='{"typedErrorCode":"DEAL_TERMINATED"}'::jsonb WHERE "id"=$1`,
        [record.id],
      ],
    ];
    for (const [name, statement, values] of tampering) {
      const failure = await runtimeAttack(statement, values);
      expect(failure, name).toMatch(
        /SPEC001_IDEMPOTENCY_OUTCOME_IMMUTABLE|SPEC001_IDEMPOTENCY_COMMAND_TIME_SET_ONCE|permission denied/i,
      );
    }
    // Deleting the historical record outright is equally refused.
    expect(
      await runtimeAttack(`DELETE FROM "ApplicationIdempotencyRecord" WHERE "id"=$1`, [record.id]),
    ).toMatch(/permission denied|SPEC001_APPEND_ONLY_VIOLATION/i);

    // The stored row is byte-for-byte what the original command committed.
    const after = await owner.query<{
      outcomeKind: string;
      outcome: Record<string, unknown>;
      commandTime: Date;
    }>(
      `SELECT "outcomeKind","outcome","commandTime" FROM "ApplicationIdempotencyRecord" WHERE "id"=$1`,
      [record.id],
    );
    expect(after.rows[0]!.outcomeKind).toBe('SUCCESS');
    expect(after.rows[0]!.outcome).toEqual(record.outcome);
    expect(after.rows[0]!.commandTime.getTime()).toBe(record.commandTime.getTime());

    // 6. Replay after the attempted tampering still returns the original committed truth.
    const replay = await acceptCurrentRevision(owner, ports, {
      actorPrincipalId: deal.counterpartyId,
      correlationId: randomUUID(),
      dealId: deal.dealId,
      targetRevisionId: deal.revisionId,
      idempotencyKey: acceptKey,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.resultKind).toBe(accepted.resultKind);
    expect(replay.dealVersion).toBe(accepted.dealVersion);
    expect(replay.agreementReady).toBe(true);

    // Even the owner cannot rewrite a settled outcome: the guard is a DB state machine, not a
    // privilege boundary.
    expect(
      await ownerAttack(
        `UPDATE "ApplicationIdempotencyRecord" SET "outcome"='{"tampered":true}'::jsonb WHERE "id"=$1`,
        [record.id],
      ),
    ).toMatch(/SPEC001_IDEMPOTENCY_OUTCOME_IMMUTABLE/);
  });

  it('spec001_transaction_lifecycle_failures_never_escape_untyped', async () => {
    // §27 — a raw persistence error must never become the caller contract. A user/admin
    // cancellation is not the Frozen-authorized lock/transaction-timeout category and therefore
    // must not be silently widened to DEAL_WRITE_RETRYABLE. `@prisma/adapter-pg` issues the
    // transaction-lifecycle statements (BEGIN, SET TRANSACTION ISOLATION LEVEL, and the engine's
    // COMMIT/ROLLBACK) through its own `executeRaw`. Depending on the precise lifecycle race,
    // Prisma can expose that failure as either its `P2010` wrapper or a bare `DriverAdapterError`;
    // both shapes must reach the same typed application boundary.
    //
    // This injects a *real* cancellation on that exact path: a test-only deferred constraint
    // trigger stalls inside COMMIT and a genuinely separate connection cancels the backend while
    // it is stalled. No production code carries a test hook.
    await owner.query('CREATE TABLE IF NOT EXISTS spec001_test_commit_stall (id int primary key)');
    // A prior interrupted evidence run may have stopped before this test's normal teardown.
    // Re-establish the fixture precondition explicitly so reruns still exercise COMMIT cancellation.
    await owner.query('TRUNCATE spec001_test_commit_stall');
    await owner.query(`CREATE OR REPLACE FUNCTION spec001_test_commit_stall_fn() RETURNS TRIGGER
        LANGUAGE plpgsql AS $fn$ BEGIN PERFORM pg_sleep(5); RETURN NULL; END; $fn$;`);
    await owner.query(
      'DROP TRIGGER IF EXISTS spec001_test_commit_stall_trg ON spec001_test_commit_stall',
    );
    await owner.query(`CREATE CONSTRAINT TRIGGER spec001_test_commit_stall_trg AFTER INSERT
        ON spec001_test_commit_stall DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION spec001_test_commit_stall_fn()`);
    await owner.query('GRANT INSERT ON spec001_test_commit_stall TO dhamani_runtime');

    const canceller = await owner.connect();
    let captured: unknown;
    try {
      await runtime.transaction(async (sql) => {
        const backend = await sql.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
        const pid = backend.rows[0]!.pid;
        await sql.execute('INSERT INTO spec001_test_commit_stall (id) VALUES (1)');
        // Fires once the callback returns and the engine is inside COMMIT running the trigger.
        setTimeout(() => {
          void canceller.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
        }, 1500);
      });
      expect.unreachable('the cancelled COMMIT must not report success');
    } catch (error) {
      captured = error;
    } finally {
      canceller.release();
    }

    // The wrapper class is an adapter implementation detail and may differ with COMMIT timing.
    // The contract proof is that the real PostgreSQL SQLSTATE is recovered from either shape,
    // is not widened to retryable, and cannot escape the clean internal-failure boundary.
    expect(captured).toBeDefined();
    expect(driverFailureOf(captured)?.sqlState).toBe('57014');
    expect(isRetryableDatabaseError(captured)).toBe(false);
    const mapped = mapDatabaseError(captured);
    expect(mapped).toBeInstanceOf(Spec001PersistenceFailure);
    expect(mapped).not.toBe(captured);
    expect(mapped.message).toBe('SPEC001_INTERNAL_PERSISTENCE_FAILURE');
    expect(mapped.cause).toBe(captured);

    // Nothing was committed by the cancelled transaction.
    const residue = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM spec001_test_commit_stall',
    );
    expect(residue.rows[0]!.count).toBe(0);

    await owner.query('DROP TABLE IF EXISTS spec001_test_commit_stall CASCADE');
    await owner.query('DROP FUNCTION IF EXISTS spec001_test_commit_stall_fn()');
  }, 120_000);

  it('spec001_aborted_transaction_state_is_contained_not_retryable', async () => {
    // A pooled connection handed over while still inside an aborted block answers 25P02 to the
    // next command. 25P02 does not identify a Frozen-authorized timeout/deadlock/contention class,
    // so it is contained without acquiring DEAL_WRITE_RETRYABLE semantics. The 25P02 below is
    // produced by PostgreSQL itself, not fabricated.
    let captured: unknown;
    try {
      await runtime.prisma.$transaction(
        async (tx) => {
          try {
            await tx.$queryRawUnsafe('SELECT 1 / 0');
          } catch {
            // deliberately continue on the now-aborted connection, as a poisoned handover does
          }
          await tx.$queryRawUnsafe('SELECT 1');
        },
        { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10_000 },
      );
      expect.unreachable('a statement on an aborted transaction must not succeed');
    } catch (error) {
      captured = error;
    }

    expect(driverFailureOf(captured)?.sqlState).toBe('25P02');
    expect(isRetryableDatabaseError(captured)).toBe(false);
    const boundary = mapDatabaseError(captured);
    expect(boundary).toBeInstanceOf(Spec001PersistenceFailure);
    expect(boundary).not.toBe(captured);
    expect(boundary.cause).toBe(captured);
  });
});
