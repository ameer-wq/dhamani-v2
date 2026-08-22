/**
 * §24.6 — fail-closed runtime-role readiness.
 *
 * Contractual-write readiness must not become healthy unless the *actual* database credential the
 * application is using is a constrained non-owner. The evaluation is pure so it can be driven
 * both by live `pg_class`/privilege queries and by a negative fixture that supplies an
 * owner/migration credential, which is what proves a stricter CI fixture cannot mask an unsafe
 * production DATABASE_URL.
 */

/** The six tables the Frozen SPEC mandates (§24). */
export const SPEC001_TABLES = [
  'AgreementRevision',
  'ApplicationIdempotencyRecord',
  'Deal',
  'DealAgreementAuditEvent',
  'DealPartySlot',
  'RevisionResponse',
] as const;

export type Spec001Table = (typeof SPEC001_TABLES)[number];

/** Privileges the runtime role must never hold on any SPEC-001 table (§24.5). */
export const DENIED_TABLE_PRIVILEGES = ['TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

export type RuntimeRoleFacts = Readonly<{
  currentUser: string;
  isSuperuser: boolean;
  /** True when the runtime credential is, or inherits, the migration/owner role. */
  isMemberOfOwnerRole: boolean;
  /** SPEC-001 tables whose owner is the current credential. Must be empty. */
  ownedTables: readonly string[];
  /** Table/privilege pairs the credential actually holds from the denied set. Must be empty. */
  heldDeniedPrivileges: readonly Readonly<{ table: string; privilege: string }>[];
  /** True when the credential may set session_replication_role (superuser-only in practice). */
  canBypassTriggers: boolean;
  /** Tables observed. Used to prove the check actually covered all six. */
  observedTables: readonly string[];
}>;

export type ReadinessVerdict = Readonly<{
  healthy: boolean;
  failures: readonly string[];
}>;

export function evaluateRuntimeRoleReadiness(facts: RuntimeRoleFacts): ReadinessVerdict {
  const failures: string[] = [];

  if (facts.isSuperuser) failures.push('RUNTIME_CREDENTIAL_IS_SUPERUSER');
  if (facts.isMemberOfOwnerRole) failures.push('RUNTIME_CREDENTIAL_IS_OWNER_OR_MEMBER');
  if (facts.canBypassTriggers) failures.push('RUNTIME_CREDENTIAL_CAN_BYPASS_TRIGGERS');

  for (const table of facts.ownedTables) failures.push(`RUNTIME_CREDENTIAL_OWNS_TABLE:${table}`);
  for (const held of facts.heldDeniedPrivileges)
    failures.push(`RUNTIME_CREDENTIAL_HOLDS_DENIED_PRIVILEGE:${held.table}.${held.privilege}`);

  // The probe must have actually inspected all six tables. A check that silently observed
  // nothing would otherwise look identical to a clean result.
  const missing = SPEC001_TABLES.filter((table) => !facts.observedTables.includes(table));
  for (const table of missing) failures.push(`RUNTIME_ROLE_CHECK_DID_NOT_OBSERVE_TABLE:${table}`);

  return Object.freeze({ healthy: failures.length === 0, failures: Object.freeze(failures) });
}
