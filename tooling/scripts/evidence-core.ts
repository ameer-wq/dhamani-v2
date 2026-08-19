export type EvidenceKind =
  | 'automated_test'
  | 'static_validator'
  | 'build_or_migration_check'
  | 'runtime_integration_check'
  | 'external_platform_check';

export type Evidence = { kind: EvidenceKind; command: string };
export type EvidenceManifest = {
  version: number;
  invariants: Record<string, string[]>;
  evidence: Record<string, Evidence>;
  executionOrder: string[];
  spec001RequiredEvidence?: {
    r2CleanIncorporation: string[];
    earthquakeScenarios: string[];
  };
};
export type CommandResult = { exitCode: number; output: string };
export type VitestReport = {
  success: boolean;
  numPendingTests: number;
  numTodoTests: number;
  testResults: Array<{
    assertionResults: Array<{ fullName: string; status: string }>;
  }>;
};
export type EvidenceResult = {
  evidenceId: string;
  exists: boolean;
  executionStatus: 'passed' | 'failed' | 'missing' | 'skipped' | 'todo';
  exitCode: number;
  pass: boolean;
  command: string;
  details?: unknown;
};

const allowedKinds = new Set<EvidenceKind>([
  'automated_test',
  'static_validator',
  'build_or_migration_check',
  'runtime_integration_check',
  'external_platform_check',
]);

const requiredCriticalEvidence: Record<
  string,
  Array<{ id: string; kind: EvidenceKind; command: string }>
> = {
  'INV-000-001': [
    {
      id: 'spec000_no_product_logic_surface',
      kind: 'static_validator',
      command: 'pnpm spec000:zero-product-logic:verify',
    },
  ],
  'INV-000-002': [
    {
      id: 'spec000_all_workspaces_strict_typecheck',
      kind: 'build_or_migration_check',
      command: 'pnpm typecheck',
    },
    {
      id: 'spec000_no_workspace_weakens_required_ts_flags',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-000-003': [
    {
      id: 'spec000_dependency_boundaries_enforced',
      kind: 'static_validator',
      command: 'pnpm boundaries:check',
    },
  ],
  'INV-000-004': [
    {
      id: 'spec000_no_app_to_app_imports',
      kind: 'static_validator',
      command: 'pnpm boundaries:check',
    },
  ],
  'INV-000-005': [
    {
      id: 'spec000_domain_is_pure_typescript',
      kind: 'static_validator',
      command: 'pnpm boundaries:check',
    },
  ],
  'INV-000-006': [
    { id: 'spec000_runtime_mode_fail_closed', kind: 'automated_test', command: 'pnpm test' },
  ],
  'INV-000-007': [
    {
      id: 'spec000_process_env_access_is_config_only',
      kind: 'static_validator',
      command: 'pnpm boundaries:check',
    },
    {
      id: 'spec000_runtime_config_is_startup_immutable',
      kind: 'automated_test',
      command: 'pnpm test',
    },
    {
      id: 'spec000_runtime_mode_request_inputs_have_no_authority',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-000-008': [
    {
      id: 'spec000_production_testkit_absence',
      kind: 'static_validator',
      command: 'pnpm boundaries:check',
    },
    {
      id: 'spec000_production_build_testkit_absence',
      kind: 'build_or_migration_check',
      command: 'pnpm spec000:build-artifacts:verify',
    },
  ],
  'INV-000-009': [
    {
      id: 'spec000_no_private_secret_public_env_surface',
      kind: 'static_validator',
      command: 'pnpm secrets:check',
    },
  ],
  'INV-000-010': [
    {
      id: 'spec000_secret_scan_is_required_gate',
      kind: 'static_validator',
      command: 'pnpm secrets:check',
    },
  ],
  'INV-000-011': [
    {
      id: 'spec000_frozen_lockfile_install',
      kind: 'build_or_migration_check',
      command: 'pnpm install --frozen-lockfile',
    },
  ],
  'INV-000-012': [
    {
      id: 'spec000_real_migration_probe_applies',
      kind: 'runtime_integration_check',
      command: 'pnpm spec000:migration:verify',
    },
  ],
  'INV-000-013': [
    { id: 'spec000_no_db_push_in_production_or_ci', kind: 'automated_test', command: 'pnpm test' },
  ],
  'INV-000-014': [
    {
      id: 'spec000_api_has_no_product_routes',
      kind: 'static_validator',
      command: 'pnpm spec000:zero-product-logic:verify',
    },
  ],
  'INV-000-015': [
    {
      id: 'spec000_readiness_reflects_real_database_dependency',
      kind: 'runtime_integration_check',
      command: 'pnpm spec000:readiness:verify',
    },
  ],
  'INV-000-016': [
    {
      id: 'spec000_logging_redaction_positive_probe',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-000-017': [
    { id: 'spec000_scripts_are_cross_platform', kind: 'automated_test', command: 'pnpm test' },
  ],
  'INV-000-018A': [
    {
      id: 'spec000_required_ci_definition_fail_closed',
      kind: 'static_validator',
      command: 'pnpm spec000:ci-definition:verify',
    },
  ],
  'INV-000-018B': [
    {
      id: 'spec000_github_branch_protection_verified',
      kind: 'external_platform_check',
      command: 'pnpm spec000:github-protection:verify',
    },
  ],
  'INV-000-019': [
    {
      id: 'spec000_mobile_has_no_server_db_dependency',
      kind: 'static_validator',
      command: 'pnpm boundaries:check',
    },
  ],
  'INV-000-020': [
    {
      id: 'spec000_no_auth_payment_provider_or_mock_surface',
      kind: 'static_validator',
      command: 'pnpm spec000:zero-product-logic:verify',
    },
  ],
  'INV-000-021': [
    {
      id: 'spec000_mobile_typecheck',
      kind: 'build_or_migration_check',
      command: 'pnpm mobile:typecheck',
    },
    {
      id: 'spec000_mobile_doctor',
      kind: 'build_or_migration_check',
      command: 'pnpm mobile:doctor',
    },
    {
      id: 'spec000_mobile_export_ci',
      kind: 'build_or_migration_check',
      command: 'pnpm mobile:export:ci',
    },
  ],
  'INV-000-022': [
    {
      id: 'spec000_evidence_registry_matches_executed_results',
      kind: 'static_validator',
      command: 'pnpm spec000:evidence:verify',
    },
  ],
  'INV-000-023': [
    {
      id: 'spec000_evidence_registry_self_test',
      kind: 'static_validator',
      command: 'pnpm spec000:evidence:verify',
    },
  ],
  'INV-000-024': [
    {
      id: 'spec000_toolchain_versions_are_enforced',
      kind: 'static_validator',
      command: 'pnpm toolchain:verify',
    },
  ],
  'INV-000-025': [
    { id: 'spec000_env_files_are_gitignored', kind: 'automated_test', command: 'pnpm test' },
  ],
  'INV-000-026': [
    {
      id: 'spec000_production_rejects_dev_configuration',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
};

/**
 * SPEC-001 introduces the first product kernel, so its invariants join the frozen registry rather
 * than replacing it. Every SPEC-000 row below is preserved unchanged; the SPEC-001 rows are
 * additive and equally fail-closed, so a manifest cannot silently drop a required item.
 */
const requiredSpec001Evidence: Record<
  string,
  Array<{ id: string; kind: EvidenceKind; command: string }>
> = {
  'INV-001-001': [
    {
      id: 'spec001_v1_deal_type_registry_is_exact_and_no_deposit',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-002': [
    {
      id: 'spec001_role_pair_is_server_derived_per_deal',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-003': [
    {
      id: 'spec001_same_principal_cannot_bind_both_slots',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-004': [
    {
      id: 'spec001_committed_deal_has_exactly_two_party_slots',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-005': [
    { id: 'spec001_deal_birth_is_all_or_nothing', kind: 'automated_test', command: 'pnpm test' },
  ],
  'INV-001-006': [
    {
      id: 'spec001_formal_identity_fields_cannot_be_mutated',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-007': [
    {
      id: 'spec001_pending_invite_is_opaque_and_one_time_bind',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-008': [
    {
      id: 'spec001_invitation_expiry_is_server_authoritative_168h',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-009': [
    {
      id: 'spec001_first_mutual_acceptance_consumes_invitation_expiry',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-010': [
    {
      id: 'spec001_revision_rejects_update_delete_truncate_direct_sql',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-011': [
    {
      id: 'spec001_revision_chain_is_linear_and_same_deal',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-012': [
    {
      id: 'spec001_concurrent_successor_race_has_one_winner',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-013': [
    {
      id: 'spec001_revision_creator_auto_accepts_exact_revision',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-014': [
    {
      id: 'spec001_acceptance_is_exact_revision_only',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-015': [
    {
      id: 'spec001_successor_makes_prior_acceptance_stale_not_deleted',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-016': [
    {
      id: 'spec001_agreement_ready_is_strictly_derived',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-017': [
    {
      id: 'spec001_client_terms_cannot_author_domain_authority',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-018': [
    {
      id: 'spec001_reject_terminates_deal_negotiation',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-019': [
    {
      id: 'spec001_invitation_withdraw_preconditions_are_strict',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-020': [
    {
      id: 'spec001_successor_creator_can_terminally_withdraw_waiting_negotiation',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-021': [
    {
      id: 'spec001_modification_credits_are_history_derived_and_bounded',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-022': [
    { id: 'spec001_negotiation_is_turn_based', kind: 'automated_test', command: 'pnpm test' },
  ],
  'INV-001-023': [
    {
      id: 'spec001_public_reference_unique_stable_and_collision_safe',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-024': [
    {
      id: 'spec001_terms_fingerprint_is_jcs_sha256_deterministic',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-025': [
    {
      id: 'spec001_contract_text_is_preserved_exactly',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-026': [
    {
      id: 'spec001_terms_envelope_is_bounded_and_schema_bound',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-027': [
    {
      id: 'spec001_all_write_commands_are_idempotent',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-028': [
    {
      id: 'spec001_idempotency_key_payload_change_conflicts',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-029': [
    {
      id: 'spec001_writes_are_deal_scoped_not_global_lock',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-030': [
    {
      id: 'spec001_stale_action_loses_with_typed_conflict',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-031': [
    {
      id: 'spec001_runtime_role_cannot_bypass_db_protections',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-032': [
    {
      id: 'spec001_domain_write_and_audit_commit_atomically',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-033': [
    {
      id: 'spec001_restart_persistence_preserves_agreement_truth',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-034': [
    {
      id: 'spec001_payer_role_is_deterministic_and_money_absent',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-035': [
    {
      id: 'spec001_has_no_untrusted_principal_http_authority',
      kind: 'static_validator',
      command: 'pnpm spec000:zero-product-logic:verify',
    },
  ],
  'INV-001-036': [
    {
      id: 'spec001_zero_financial_execution_surface',
      kind: 'static_validator',
      command: 'pnpm spec000:zero-product-logic:verify',
    },
  ],
  'INV-001-037': [
    {
      id: 'spec001_current_revision_fk_is_nonnull_same_deal_and_deferred',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-038': [
    {
      id: 'spec001_command_time_is_single_db_value_after_lock',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-039': [
    {
      id: 'spec001_revision_integrity_failure_fails_closed',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-040': [
    {
      id: 'spec001_entity_ids_are_server_uuidv7_only',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-041': [
    {
      id: 'spec001_audit_and_logs_contain_no_terms_or_pii',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-042': [
    {
      id: 'spec001_reads_require_authorized_actor_scope',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-043': [
    {
      id: 'spec001_e39_four_way_conflicting_action_race',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-044': [
    {
      id: 'spec001_e40_expiry_materializer_after_timer_consumed',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
  'INV-001-045': [
    { id: 'spec001_e41_pending_bind_terminal_race', kind: 'automated_test', command: 'pnpm test' },
  ],
  'INV-001-046': [
    {
      id: 'spec001_e42_idempotent_replay_after_later_state_change',
      kind: 'automated_test',
      command: 'pnpm test',
    },
  ],
};

/** The 42 manifest-bound earthquake scenario identities (Frozen SPEC §32). */
export const requiredSpec001EarthquakeIds = [
  'spec001_e01_formal_birth',
  'spec001_e02_create_retries_sequential_and_concurrent',
  'spec001_e03_create_key_payload_mutation',
  'spec001_e04_same_principal_both_sides',
  'spec001_e05_pending_counterparty_birth',
  'spec001_e06_one_time_binding',
  'spec001_e07_bind_after_expiry',
  'spec001_e08_direct_r1_accept',
  'spec001_e09_r1_reject_terminal',
  'spec001_e10_r1_withdraw_accept_race',
  'spec001_e11_view_does_not_block_withdrawal',
  'spec001_e12_successor_proposal',
  'spec001_e13_successor_accept_no_deadlock',
  'spec001_e14_stale_accept_race',
  'spec001_e15_concurrent_successor_no_fork',
  'spec001_e16_turn_based_spam_blocked',
  'spec001_e17_unchanged_proposal_no_credit',
  'spec001_e18_modification_limits',
  'spec001_e19_response_loss_replay',
  'spec001_e20_duplicate_accept_retry',
  'spec001_e21_awaited_accept_concurrent_double_submit',
  'spec001_e22_exact_expiry_boundary_single_db_time',
  'spec001_e23_mutual_accept_before_expiry_consumes_timer',
  'spec001_e24_reshare_cannot_move_invite_time',
  'spec001_e25_r2_proposer_withdrawal',
  'spec001_e26_cross_deal_revision_abuse',
  'spec001_e27_roles_are_per_deal',
  'spec001_e28_append_only_runtime_role_bypass_attacks',
  'spec001_e29_participant_db_attacks',
  'spec001_e30_current_revision_cross_deal_corruption',
  'spec001_e31_birth_failure_injection_matrix',
  'spec001_e32_successor_failure_rollback',
  'spec001_e33_real_restart_preserves_truth',
  'spec001_e34_jcs_key_order_and_whitespace',
  'spec001_e35_contract_string_distinction',
  'spec001_e36_terms_payload_bounds',
  'spec001_e37_unsupported_schema_fail_closed',
  'spec001_e38_terms_authority_smuggling_is_inert',
  'spec001_e39_four_way_conflicting_action_race',
  'spec001_e40_expiry_materializer_after_timer_consumed',
  'spec001_e41_pending_bind_terminal_race',
  'spec001_e42_idempotent_replay_after_later_state_change',
] as const;

/** Additional required gate evidence from R2 clean incorporation (Frozen SPEC §31). */
export const requiredSpec001R2Ids = [
  'spec001_runtime_connection_role_is_nonowner_least_privilege',
  'spec001_expiry_latch_replays_invitation_expired_consistently',
  'spec001_raw_terms_cap_rejects_before_decode',
  'spec001_terminal_error_payload_exposes_termination_reason',
] as const;

export const frozenRequiredCommands = [
  'pnpm install --frozen-lockfile',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm boundaries:check',
  'pnpm test',
  'pnpm build',
  'pnpm db:validate',
  'pnpm secrets:check',
  'pnpm mobile:typecheck',
  'pnpm mobile:doctor',
  'pnpm mobile:export:ci',
  'pnpm spec000:zero-product-logic:verify',
  'pnpm spec000:ci-definition:verify',
  'pnpm toolchain:verify',
  'pnpm spec000:migration:verify',
  'pnpm spec000:readiness:verify',
  'pnpm spec000:github-protection:verify',
] as const;

export function commandOwnerExists(command: string, scripts: Record<string, string>): boolean {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'pnpm') return false;
  if (words[1] === 'install') return true;
  const script = words[1];
  return script !== undefined && typeof scripts[script] === 'string' && scripts[script].length > 0;
}

export function validateEvidenceManifest(
  manifest: EvidenceManifest,
  scripts: Record<string, string>,
  requiredCommands: readonly string[] = frozenRequiredCommands,
): string[] {
  const errors: string[] = [];
  const allRequired = { ...requiredCriticalEvidence, ...requiredSpec001Evidence };
  const actualInvariantIds = Object.keys(manifest.invariants).sort();
  const requiredInvariantIds = Object.keys(allRequired).sort();
  if (JSON.stringify(actualInvariantIds) !== JSON.stringify(requiredInvariantIds))
    errors.push(
      `critical invariant registry differs actual=${JSON.stringify(actualInvariantIds)} expected=${JSON.stringify(requiredInvariantIds)}`,
    );

  // Every earthquake scenario and R2 clean-incorporation item must be declared and owned by a
  // real executable command, so none of them can quietly disappear from the aggregate.
  const declared = manifest.spec001RequiredEvidence;
  if (!declared) errors.push('manifest declares no spec001RequiredEvidence block');
  else {
    for (const [label, expected, actual] of [
      ['earthquake', requiredSpec001EarthquakeIds, declared.earthquakeScenarios],
      ['r2', requiredSpec001R2Ids, declared.r2CleanIncorporation],
    ] as const) {
      if (JSON.stringify([...expected]) !== JSON.stringify([...actual]))
        errors.push(`${label} evidence identities differ from the frozen SPEC-001 list`);
      for (const id of expected)
        if (!manifest.evidence[id]) errors.push(`${label} evidence missing from manifest: ${id}`);
    }
  }

  for (const [invariant, descriptors] of Object.entries(allRequired)) {
    const mapped = manifest.invariants[invariant] ?? [];
    const expectedIds = descriptors.map((descriptor) => descriptor.id).sort();
    if (JSON.stringify([...mapped].sort()) !== JSON.stringify(expectedIds))
      errors.push(`${invariant} evidence mapping differs from frozen requirements`);
    for (const descriptor of descriptors) {
      const evidence = manifest.evidence[descriptor.id];
      if (!evidence || evidence.kind !== descriptor.kind || evidence.command !== descriptor.command)
        errors.push(`${descriptor.id} kind or command differs from frozen requirement`);
    }
  }
  for (const [invariant, ids] of Object.entries(manifest.invariants)) {
    if (ids.length === 0) errors.push(`${invariant} has no evidence`);
    for (const id of ids) {
      const evidence = manifest.evidence[id];
      if (!evidence || !allowedKinds.has(evidence.kind) || !evidence.command)
        errors.push(`${invariant} references invalid evidence ${id}`);
    }
  }
  const selfCommands = new Set(['pnpm spec000:evidence:verify']);
  for (const [id, evidence] of Object.entries(manifest.evidence)) {
    if (!allowedKinds.has(evidence.kind)) errors.push(`${id} has forbidden evidence kind`);
    if (!commandOwnerExists(evidence.command, scripts))
      errors.push(`${id} points to nonexistent command owner ${evidence.command}`);
    if (!selfCommands.has(evidence.command) && !manifest.executionOrder.includes(evidence.command))
      errors.push(`${id} command is absent from executionOrder: ${evidence.command}`);
  }
  for (const command of requiredCommands)
    if (!manifest.executionOrder.includes(command))
      errors.push(`required command missing from executionOrder: ${command}`);
  for (const command of manifest.executionOrder) {
    if (!commandOwnerExists(command, scripts))
      errors.push(`execution command does not exist: ${command}`);
    if (!Object.values(manifest.evidence).some((evidence) => evidence.command === command))
      errors.push(`execution command has no evidence owner: ${command}`);
  }
  return [...new Set(errors)];
}

function assertionStatus(
  evidenceId: string,
  vitest: VitestReport | undefined,
): {
  executionStatus: 'passed' | 'failed' | 'missing' | 'skipped' | 'todo';
  testIdentity: string | null;
  runnerStatus: string | null;
} {
  if (!vitest) return { executionStatus: 'missing', testIdentity: null, runnerStatus: null };
  const matches = vitest.testResults
    .flatMap((suite) => suite.assertionResults)
    .filter(
      (assertion) =>
        assertion.fullName === evidenceId || assertion.fullName.endsWith(` ${evidenceId}`),
    );
  if (matches.length !== 1)
    return {
      executionStatus: matches.length === 0 ? 'missing' : 'failed',
      testIdentity:
        matches.length === 0 ? null : matches.map((match) => match.fullName).join(' | '),
      runnerStatus: matches.length === 0 ? null : 'ambiguous',
    };
  const status = matches[0]!.status;
  const executionStatus =
    status === 'passed'
      ? 'passed'
      : status === 'todo'
        ? 'todo'
        : status === 'pending' || status === 'skipped'
          ? 'skipped'
          : 'failed';
  return { executionStatus, testIdentity: matches[0]!.fullName, runnerStatus: status };
}

export function evaluateEvidence(
  id: string,
  evidence: Evidence,
  scripts: Record<string, string>,
  commandResults: ReadonlyMap<string, CommandResult>,
  vitest: VitestReport | undefined,
): EvidenceResult {
  const exists = commandOwnerExists(evidence.command, scripts);
  const commandResult = commandResults.get(evidence.command);
  if (!exists)
    return {
      evidenceId: id,
      exists: false,
      executionStatus: 'missing',
      exitCode: 1,
      pass: false,
      command: evidence.command,
    };
  if (!commandResult)
    return {
      evidenceId: id,
      exists: true,
      executionStatus: 'missing',
      exitCode: 1,
      pass: false,
      command: evidence.command,
    };
  const automatedDecision =
    evidence.kind === 'automated_test' ? assertionStatus(id, vitest) : undefined;
  if (commandResult.exitCode !== 0)
    return {
      evidenceId: id,
      exists: true,
      executionStatus: 'failed',
      exitCode: commandResult.exitCode,
      pass: false,
      command: evidence.command,
      ...(automatedDecision ? { details: automatedDecision } : {}),
    };
  const executionStatus = automatedDecision?.executionStatus ?? 'passed';
  return {
    evidenceId: id,
    exists: true,
    executionStatus,
    exitCode: commandResult.exitCode,
    pass: executionStatus === 'passed',
    command: evidence.command,
    ...(automatedDecision ? { details: automatedDecision } : {}),
  };
}

export function vitestReportPasses(report: VitestReport | undefined): boolean {
  return (
    report !== undefined &&
    report.success &&
    report.numPendingTests === 0 &&
    report.numTodoTests === 0 &&
    report.testResults
      .flatMap((suite) => suite.assertionResults)
      .every((assertion) => assertion.status === 'passed')
  );
}

export function aggregatePasses(
  results: readonly EvidenceResult[],
  commandResults: ReadonlyMap<string, CommandResult>,
  selectedCommands: readonly string[],
  manifestErrors: readonly string[],
  selfTestPasses: boolean,
  vitest: VitestReport | undefined,
): boolean {
  return (
    manifestErrors.length === 0 &&
    selfTestPasses &&
    vitestReportPasses(vitest) &&
    selectedCommands.every((command) => commandResults.get(command)?.exitCode === 0) &&
    results.every((result) => result.pass)
  );
}

function report(status?: string): VitestReport {
  return {
    success: status === 'passed',
    numPendingTests: status === 'skipped' ? 1 : 0,
    numTodoTests: status === 'todo' ? 1 : 0,
    testResults: status
      ? [{ assertionResults: [{ fullName: 'fixture spec000_self_test_probe', status }] }]
      : [{ assertionResults: [] }],
  };
}

export type RegistrySelfTestFixture = { name: string; rejected: boolean; reason: string };

/**
 * The five §22.1 fixture classes, frozen in order. `summarizeRegistrySelfTest` refuses to pass
 * unless every class is present under its exact name, so no class can be silently dropped.
 */
export const registrySelfTestFixtureNames = [
  'nonexistent-evidence-id',
  'skipped-test',
  'todo-test',
  'failed-check',
  'missing-raw-result',
] as const;

/**
 * Each fixture is rejected only when the aggregator's decision matches this exact reason. A
 * rejection produced by any other defect leaves `rejected` false, so a fixture cannot appear to
 * prove its class while actually failing for an unrelated cause.
 */
export const registrySelfTestReasons: Record<
  (typeof registrySelfTestFixtureNames)[number],
  string
> = {
  'nonexistent-evidence-id': 'invariant references an evidence id absent from the manifest',
  'skipped-test': 'raw runner status skipped',
  'todo-test': 'raw runner status todo',
  'failed-check': 'executed command exit nonzero',
  'missing-raw-result': 'declared automated test absent from raw runner output',
};

export const nonexistentEvidenceFixtureId = 'spec000_nonexistent_evidence_fixture';
export const nonexistentEvidenceFixtureInvariant = 'INV-000-023';

export function nonexistentEvidenceFixtureError(): string {
  return `${nonexistentEvidenceFixtureInvariant} references invalid evidence ${nonexistentEvidenceFixtureId}`;
}

export function summarizeRegistrySelfTest(fixtures: readonly RegistrySelfTestFixture[]) {
  const declaredNames = JSON.stringify(fixtures.map((fixture) => fixture.name));
  const frozenNames = JSON.stringify([...registrySelfTestFixtureNames]);
  return {
    pass: declaredNames === frozenNames && fixtures.every((fixture) => fixture.rejected),
    fixtures,
  };
}

function outcome(
  name: (typeof registrySelfTestFixtureNames)[number],
  rejected: boolean,
  observed: string,
): RegistrySelfTestFixture {
  return {
    name,
    rejected,
    reason: rejected ? registrySelfTestReasons[name] : `unattributable rejection: ${observed}`,
  };
}

/**
 * Drives the real decision functions with the repository's own manifest so a fixture cannot be
 * rejected for an incidental reason (for example an incomplete synthetic invariant registry).
 */
export function registrySelfTestFixtures(
  manifest: EvidenceManifest,
  scripts: Record<string, string>,
): RegistrySelfTestFixture[] {
  const passingCommand = new Map([['pnpm test', { exitCode: 0, output: '' }]]);
  const failedCommand = new Map([['pnpm test', { exitCode: 7, output: 'failed' }]]);
  const probe = (kind: EvidenceKind): Evidence => ({ kind, command: 'pnpm test' });
  const decide = (
    kind: EvidenceKind,
    commandResults: ReadonlyMap<string, CommandResult>,
    vitest: VitestReport | undefined,
  ) => evaluateEvidence('spec000_self_test_probe', probe(kind), scripts, commandResults, vitest);

  const controlErrors = validateEvidenceManifest(manifest, scripts);
  const mutated = structuredClone(manifest);
  mutated.invariants[nonexistentEvidenceFixtureInvariant] = [nonexistentEvidenceFixtureId];
  const mutatedErrors = validateEvidenceManifest(mutated, scripts);
  const intendedManifestError = nonexistentEvidenceFixtureError();

  const skipped = decide('automated_test', passingCommand, report('skipped'));
  const todo = decide('automated_test', passingCommand, report('todo'));
  const failed = decide('static_validator', failedCommand, report('passed'));
  const missing = decide('automated_test', passingCommand, report());

  return [
    outcome(
      'nonexistent-evidence-id',
      controlErrors.length === 0 && mutatedErrors.includes(intendedManifestError),
      `control=${JSON.stringify(controlErrors)} mutated=${JSON.stringify(mutatedErrors)}`,
    ),
    outcome(
      'skipped-test',
      !skipped.pass && skipped.executionStatus === 'skipped',
      JSON.stringify(skipped),
    ),
    outcome('todo-test', !todo.pass && todo.executionStatus === 'todo', JSON.stringify(todo)),
    outcome(
      'failed-check',
      !failed.pass && failed.executionStatus === 'failed' && failed.exitCode === 7,
      JSON.stringify(failed),
    ),
    outcome(
      'missing-raw-result',
      !missing.pass && missing.executionStatus === 'missing',
      JSON.stringify(missing),
    ),
  ];
}

export function registrySelfTestResult(
  manifest: EvidenceManifest,
  scripts: Record<string, string>,
) {
  return summarizeRegistrySelfTest(registrySelfTestFixtures(manifest, scripts));
}
