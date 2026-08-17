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
  const actualInvariantIds = Object.keys(manifest.invariants).sort();
  const requiredInvariantIds = Object.keys(requiredCriticalEvidence).sort();
  if (JSON.stringify(actualInvariantIds) !== JSON.stringify(requiredInvariantIds))
    errors.push(
      `critical invariant registry differs actual=${JSON.stringify(actualInvariantIds)} expected=${JSON.stringify(requiredInvariantIds)}`,
    );
  for (const [invariant, descriptors] of Object.entries(requiredCriticalEvidence)) {
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
