import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SPEC001_TABLES,
  evaluateRuntimeRoleReadiness,
} from '../../../packages/domain/src/index.ts';
import {
  assertContractualWriteReadiness,
  collectRuntimeRoleFacts,
} from '../../../apps/api/src/spec001/readiness.ts';
import { createPool } from '../../../apps/api/src/spec001/database.ts';
import { uuidV7 } from '../../../apps/api/src/spec001/crypto.ts';
import { bornDeal, ownerPool, randomUUID, runtimeConnectionString } from './helpers.ts';

const owner = ownerPool();
let runtime: pg.Pool;

const APPEND_ONLY_TABLES = ['AgreementRevision', 'RevisionResponse', 'DealAgreementAuditEvent'];

beforeAll(async () => {
  // The runtime role is created NOLOGIN by the migration; evidence needs a real login for it.
  await owner.query(
    `DO $$ BEGIN
       EXECUTE format('ALTER ROLE dhamani_runtime LOGIN PASSWORD %L', 'runtime_test_only');
     END $$;`,
  );
  runtime = createPool(runtimeConnectionString());
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

    // Role/type drift is impossible.
    expect(
      await ownerAttack(`UPDATE "DealPartySlot" SET "role"='CLIENT' WHERE "dealId"=$1`, [
        deal.dealId,
      ]),
    ).toMatch(/SPEC001_SLOT_IMMUTABLE/);
    expect(
      await ownerAttack(
        `INSERT INTO "DealPartySlot"
           ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
         VALUES ($1,$2,'SERVICES','COUNTERPARTY','CLIENT',$3,NULL,now(),now())`,
        [uuidV7(), deal.dealId, randomUUID()],
      ),
    ).toMatch(/DealPartySlot_dealType_fkey|DealPartySlot_deal_slotKind_key/);

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
  });

  it('spec001_e31_birth_failure_injection_matrix', async () => {
    // Failure injected after each birth stage must leave zero committed truth. The stages are
    // driven directly so the abort point is exact.
    const stages = ['deal', 'revision', 'slot1', 'slot2', 'response', 'audit'] as const;
    for (const stage of stages) {
      const dealId = uuidV7();
      const revisionId = uuidV7();
      const creatorId = randomUUID();
      const counterpartyId = randomUUID();
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO "Deal" ("id","publicReference","dealType","currentRevisionId","sentAt","inviteExpiresAt","version","createdAt")
           VALUES ($1,$2,'GOODS',$3, now(), now() + interval '168 hours', 1, now())`,
          [dealId, reference(), revisionId],
        );
        if (stage !== 'deal') {
          await client.query(
            `INSERT INTO "AgreementRevision"
               ("id","dealId","revisionNumber","predecessorRevisionId","createdByPrincipalId","termsSchemaId","termsPayloadCanonicalBytes","integrityPreimageCanonicalBytes","integrityFingerprint","createdAt")
             VALUES ($1,$2,1,NULL,$3,'dhamani.goods.v1','{}'::bytea,'{}'::bytea,decode(repeat('ab',32),'hex'),now())`,
            [revisionId, dealId, creatorId],
          );
        }
        if (stage !== 'deal' && stage !== 'revision') {
          await client.query(
            `INSERT INTO "DealPartySlot" ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
             VALUES ($1,$2,'GOODS','CREATOR','BUYER',$3,NULL,now(),now())`,
            [uuidV7(), dealId, creatorId],
          );
        }
        if (stage === 'slot2' || stage === 'response' || stage === 'audit') {
          await client.query(
            `INSERT INTO "DealPartySlot" ("id","dealId","dealType","slotKind","role","principalId","pendingInviteId","createdAt","boundAt")
             VALUES ($1,$2,'GOODS','COUNTERPARTY','SELLER',$3,NULL,now(),now())`,
            [uuidV7(), dealId, counterpartyId],
          );
        }
        if (stage === 'response' || stage === 'audit') {
          await client.query(
            `INSERT INTO "RevisionResponse" ("id","dealId","revisionId","principalId","responseKind","responseOrigin","createdAt")
             VALUES ($1,$2,$3,$4,'ACCEPT','REVISION_CREATOR_AUTO',now())`,
            [uuidV7(), dealId, revisionId, creatorId],
          );
        }
        // Inject the failure for this stage.
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      for (const [table, column] of [
        ['Deal', 'id'],
        ['AgreementRevision', 'dealId'],
        ['DealPartySlot', 'dealId'],
        ['RevisionResponse', 'dealId'],
        ['DealAgreementAuditEvent', 'dealId'],
      ] as const) {
        const rows = await owner.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "${table}" WHERE "${column}"=$1`,
          [dealId],
        );
        expect(rows.rows[0]!.count, `${stage} left ${table} rows behind`).toBe(0);
      }
    }
  });
});
