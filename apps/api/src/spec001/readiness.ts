import type pg from 'pg';
import {
  DENIED_TABLE_PRIVILEGES,
  SPEC001_TABLES,
  evaluateRuntimeRoleReadiness,
  type ReadinessVerdict,
  type RuntimeRoleFacts,
} from '@dhamani/domain';

/**
 * §24.6 — before contractual-write readiness becomes healthy, the application interrogates the
 * *actual* database credential it is holding.
 *
 * This deliberately queries live catalog state (`current_user`, `pg_class.relowner`,
 * `has_table_privilege`) rather than trusting configuration, so a stricter CI fixture cannot mask
 * an unsafe production DATABASE_URL. Supplying an owner/migration credential here flips readiness
 * unhealthy, which is the required negative configuration.
 */
export async function collectRuntimeRoleFacts(pool: pg.Pool): Promise<RuntimeRoleFacts> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{
      current_user: string;
      is_superuser: boolean;
      can_bypass_rls: boolean;
    }>(
      `SELECT current_user AS current_user,
              COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
              COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS can_bypass_rls`,
    );
    const currentUser = identity.rows[0]?.current_user ?? '';
    const isSuperuser = identity.rows[0]?.is_superuser ?? true;
    const canBypassRls = identity.rows[0]?.can_bypass_rls ?? true;

    const owners = await client.query<{ table_name: string; owner: string }>(
      `SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [[...SPEC001_TABLES]],
    );
    const observedTables = owners.rows.map((row) => row.table_name);
    const ownedTables = owners.rows
      .filter((row) => row.owner === currentUser)
      .map((row) => row.table_name);

    // Membership in any owner role is as dangerous as being the owner, because privileges are
    // inherited or assumable.
    const ownerRoles = [...new Set(owners.rows.map((row) => row.owner))];
    let isMemberOfOwnerRole = false;
    for (const ownerRole of ownerRoles) {
      if (ownerRole === currentUser) {
        isMemberOfOwnerRole = true;
        continue;
      }
      const membership = await client.query<{ is_member: boolean }>(
        'SELECT pg_has_role(current_user, $1, $2) AS is_member',
        [ownerRole, 'USAGE'],
      );
      if (membership.rows[0]?.is_member) isMemberOfOwnerRole = true;
    }

    const heldDeniedPrivileges: Array<{ table: string; privilege: string }> = [];
    for (const table of observedTables) {
      for (const privilege of DENIED_TABLE_PRIVILEGES) {
        const held = await client.query<{ held: boolean }>(
          'SELECT has_table_privilege(current_user, $1, $2) AS held',
          [`public."${table}"`, privilege],
        );
        if (held.rows[0]?.held) heldDeniedPrivileges.push({ table, privilege });
      }
    }

    return Object.freeze({
      currentUser,
      isSuperuser,
      isMemberOfOwnerRole,
      ownedTables,
      heldDeniedPrivileges,
      // Only a superuser can set session_replication_role, which is the trigger-bypass route.
      canBypassTriggers: isSuperuser || canBypassRls,
      observedTables,
    });
  } finally {
    client.release();
  }
}

export async function assertContractualWriteReadiness(pool: pg.Pool): Promise<ReadinessVerdict> {
  return evaluateRuntimeRoleReadiness(await collectRuntimeRoleFacts(pool));
}
