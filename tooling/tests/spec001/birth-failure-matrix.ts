import { expect } from 'vitest';
import { createFormalDeal } from '../../../apps/api/src/spec001/commands/create-formal-deal.ts';
import type { KernelDatabase } from '../../../apps/api/src/spec001/database.ts';
import { ports, randomUUID, terms } from './helpers.ts';

const FAULT_STAGES = [
  'deal',
  'revision',
  'slot1',
  'slot2',
  'response',
  'audit',
  'idempotency',
] as const;

function reference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const group = (): string =>
    Array.from({ length: 4 }, () => alphabet.charAt(Math.floor(Math.random() * 32))).join('');
  return `DH-${group()}-${group()}-${group()}`;
}

/**
 * Shared real-transaction birth fault matrix required by INV-001-005 and E31.
 *
 * Each named identity invokes this helper itself. The production command has no fault hook: the
 * evidence injects failures with temporary database triggers and proves all six contractual table
 * families contain zero partial truth after every rollback.
 */
export async function assertBirthFailureMatrix(database: KernelDatabase): Promise<void> {
  await database.query(
    'CREATE TABLE IF NOT EXISTS spec001_test_birth_fault_r4 (marker text primary key, stage text not null)',
  );

  const install = async (table: string, name: string, body: string) => {
    await database.query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS TRIGGER
        LANGUAGE plpgsql AS $fn$
        DECLARE target text;
        BEGIN
          ${body}
          RETURN NEW;
        END; $fn$;`);
    await database.query(
      `CREATE OR REPLACE TRIGGER "${name}_trg" BEFORE INSERT OR UPDATE ON "${table}"
         FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    await database.query(`ALTER TABLE "${table}" ENABLE ALWAYS TRIGGER "${name}_trg"`);
  };

  const dealScoped = (stage: string) => `
      SELECT f.stage INTO target FROM spec001_test_birth_fault_r4 f
        JOIN "Deal" d ON d."publicReference" = f.marker
       WHERE d."id" = NEW."dealId" AND f.stage = '${stage}';
      IF target IS NOT NULL THEN
        RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_${stage}' USING ERRCODE = 'raise_exception';
      END IF;`;

  try {
    await install('AgreementRevision', 'spec001_test_r4_fault_revision', dealScoped('deal'));
    await install(
      'DealPartySlot',
      'spec001_test_r4_fault_slot',
      `SELECT f.stage INTO target FROM spec001_test_birth_fault_r4 f
         JOIN "Deal" d ON d."publicReference" = f.marker
        WHERE d."id" = NEW."dealId"
          AND ((f.stage = 'revision' AND NEW."slotKind" = 'CREATOR')
            OR (f.stage = 'slot1' AND NEW."slotKind" = 'COUNTERPARTY'));
       IF target IS NOT NULL THEN
         RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_slot' USING ERRCODE = 'raise_exception';
       END IF;`,
    );
    await install('RevisionResponse', 'spec001_test_r4_fault_response', dealScoped('slot2'));
    await install('DealAgreementAuditEvent', 'spec001_test_r4_fault_audit', dealScoped('response'));
    await install(
      'ApplicationIdempotencyRecord',
      'spec001_test_r4_fault_idempotency',
      `SELECT f.stage INTO target FROM spec001_test_birth_fault_r4 f
        WHERE f.marker = NEW."idempotencyKey" AND f.stage = 'audit';
       IF target IS NOT NULL AND NEW."outcomeKind" <> 'PENDING' THEN
         RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_audit' USING ERRCODE = 'raise_exception';
       END IF;`,
    );
    await database.query(`CREATE OR REPLACE FUNCTION spec001_test_r4_fault_commit()
        RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
        DECLARE target text;
        BEGIN
          SELECT f.stage INTO target FROM spec001_test_birth_fault_r4 f
           WHERE f.marker = NEW."publicReference" AND f.stage = 'idempotency';
          IF target IS NOT NULL THEN
            RAISE EXCEPTION 'INJECTED_BIRTH_FAILURE_commit' USING ERRCODE = 'raise_exception';
          END IF;
          RETURN NULL;
        END; $fn$;`);
    await database
      .query('DROP TRIGGER IF EXISTS "spec001_test_r4_fault_commit_trg" ON "Deal"')
      .catch(() => undefined);
    await database.query(
      `CREATE CONSTRAINT TRIGGER "spec001_test_r4_fault_commit_trg" AFTER INSERT ON "Deal"
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
         EXECUTE FUNCTION spec001_test_r4_fault_commit()`,
    );

    for (const stage of FAULT_STAGES) {
      const marker = reference();
      const idempotencyKey = randomUUID();
      const actorPrincipalId = randomUUID();
      await database.query(
        'INSERT INTO spec001_test_birth_fault_r4 (marker, stage) VALUES ($1,$2)',
        [stage === 'audit' ? idempotencyKey : marker, stage],
      );

      let failure: unknown;
      try {
        await createFormalDeal(
          database,
          { ...ports, newPublicReference: () => marker },
          {
            actorPrincipalId,
            correlationId: randomUUID(),
            dealType: 'GOODS',
            creatorRole: 'BUYER',
            counterpartyTarget: { kind: 'PRINCIPAL', principalId: randomUUID() },
            termsSchemaId: 'dhamani.goods.v1',
            rawTerms: terms(`Birth failure ${stage}`),
            idempotencyKey,
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure, `stage ${stage} must inject a real failure`).toBeDefined();

      const residue = await database.query<{
        deals: number;
        revisions: number;
        slots: number;
        responses: number;
        events: number;
        claims: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM "Deal" WHERE "publicReference"=$1) AS deals,
           (SELECT count(*)::int FROM "AgreementRevision" r JOIN "Deal" d ON d."id"=r."dealId"
             WHERE d."publicReference"=$1) AS revisions,
           (SELECT count(*)::int FROM "DealPartySlot" s JOIN "Deal" d ON d."id"=s."dealId"
             WHERE d."publicReference"=$1) AS slots,
           (SELECT count(*)::int FROM "RevisionResponse" p JOIN "Deal" d ON d."id"=p."dealId"
             WHERE d."publicReference"=$1) AS responses,
           (SELECT count(*)::int FROM "DealAgreementAuditEvent" a JOIN "Deal" d ON d."id"=a."dealId"
             WHERE d."publicReference"=$1) AS events,
           (SELECT count(*)::int FROM "ApplicationIdempotencyRecord"
             WHERE "idempotencyKey"=$2) AS claims`,
        [marker, idempotencyKey],
      );
      expect(residue.rows[0], `stage ${stage} left partial committed truth`).toEqual({
        deals: 0,
        revisions: 0,
        slots: 0,
        responses: 0,
        events: 0,
        claims: 0,
      });
      await database.query('DELETE FROM spec001_test_birth_fault_r4');
    }

    const healthy = await createFormalDeal(database, ports, {
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
      ['AgreementRevision', 'spec001_test_r4_fault_revision'],
      ['DealPartySlot', 'spec001_test_r4_fault_slot'],
      ['RevisionResponse', 'spec001_test_r4_fault_response'],
      ['DealAgreementAuditEvent', 'spec001_test_r4_fault_audit'],
      ['ApplicationIdempotencyRecord', 'spec001_test_r4_fault_idempotency'],
    ] as const) {
      await database
        .query(`DROP TRIGGER IF EXISTS "${name}_trg" ON "${table}"`)
        .catch(() => undefined);
      await database.query(`DROP FUNCTION IF EXISTS ${name}()`).catch(() => undefined);
    }
    await database
      .query('DROP TRIGGER IF EXISTS "spec001_test_r4_fault_commit_trg" ON "Deal"')
      .catch(() => undefined);
    await database
      .query('DROP FUNCTION IF EXISTS spec001_test_r4_fault_commit()')
      .catch(() => undefined);
    await database.query('DROP TABLE IF EXISTS spec001_test_birth_fault_r4').catch(() => undefined);
  }
}
