import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  commandOwnerExists,
  evaluateEvidence,
  nonexistentEvidenceFixtureError,
  registrySelfTestFixtureNames,
  registrySelfTestFixtures,
  registrySelfTestReasons,
  registrySelfTestResult,
  summarizeRegistrySelfTest,
  validateEvidenceManifest,
  type EvidenceManifest,
} from '../scripts/evidence-core.ts';
import { combinedOutput, runToolingScript } from './fixture-helpers.ts';

function committedManifest(): EvidenceManifest {
  return JSON.parse(readFileSync('evidence/manifest.json', 'utf8')) as EvidenceManifest;
}

function rootScripts(): Record<string, string> {
  return (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> })
    .scripts;
}

describe('evidence registry fail-closed regressions', () => {
  it('executes and rejects all five frozen self-test fixture classes', () => {
    const result = registrySelfTestResult(committedManifest(), rootScripts());
    expect(result.pass).toBe(true);
    expect(result.fixtures).toEqual(
      registrySelfTestFixtureNames.map((name) => ({
        name,
        rejected: true,
        reason: registrySelfTestReasons[name],
      })),
    );
  });

  it('attributes the nonexistent-evidence rejection to the evidence-reference path alone', () => {
    const manifest = committedManifest();
    const scripts = rootScripts();
    // Control: the committed manifest itself must produce no errors, so the fixture's rejection
    // can only come from its own mutation.
    expect(validateEvidenceManifest(manifest, scripts)).toEqual([]);

    // The pre-remediation fixture used a minimal synthetic manifest. It was rejected, but only
    // because its invariant registry was incomplete -- never because of a nonexistent evidence
    // id. That shape must not be able to satisfy this fixture class.
    const incompleteRegistry: EvidenceManifest = {
      ...manifest,
      invariants: { 'INV-000-023': ['spec000_evidence_registry_self_test'] },
    };
    const incompleteErrors = validateEvidenceManifest(incompleteRegistry, scripts);
    expect(incompleteErrors.length).toBeGreaterThan(0);
    expect(incompleteErrors.some((error) => error.includes('references invalid evidence'))).toBe(
      false,
    );

    // The real mutation produces the intended, isolated reason.
    const mutated = structuredClone(manifest);
    mutated.invariants['INV-000-023'] = ['spec000_nonexistent_evidence_fixture'];
    expect(validateEvidenceManifest(mutated, scripts)).toContain(nonexistentEvidenceFixtureError());
  });

  it('leaves a fixture unattributed when its decision path stops firing', () => {
    // A skipped raw runner status that is scored as passed must not read as a rejection.
    const scripts = rootScripts();
    const accepted = evaluateEvidence(
      'spec000_self_test_probe',
      { kind: 'static_validator', command: 'pnpm test' },
      scripts,
      new Map([['pnpm test', { exitCode: 0, output: '' }]]),
      undefined,
    );
    expect(accepted.pass).toBe(true);
    expect(
      summarizeRegistrySelfTest([
        { name: 'nonexistent-evidence-id', rejected: false, reason: 'unattributable rejection: x' },
        { name: 'skipped-test', rejected: true, reason: registrySelfTestReasons['skipped-test'] },
        { name: 'todo-test', rejected: true, reason: registrySelfTestReasons['todo-test'] },
        { name: 'failed-check', rejected: true, reason: registrySelfTestReasons['failed-check'] },
        {
          name: 'missing-raw-result',
          rejected: true,
          reason: registrySelfTestReasons['missing-raw-result'],
        },
      ]).pass,
    ).toBe(false);
  });

  it('refuses a self-test that drops or renames one of the five frozen fixture classes', () => {
    const fixtures = registrySelfTestFixtures(committedManifest(), rootScripts());
    expect(summarizeRegistrySelfTest(fixtures.slice(1)).pass).toBe(false);
    expect(
      summarizeRegistrySelfTest([{ ...fixtures[0]!, name: 'renamed' }, ...fixtures.slice(1)]).pass,
    ).toBe(false);
  });

  it('computes self-test failure when one real decision fixture is accepted', () => {
    const fixtures = registrySelfTestFixtures(committedManifest(), rootScripts());
    fixtures[0] = { ...fixtures[0]!, rejected: false };
    expect(summarizeRegistrySelfTest(fixtures).pass).toBe(false);
    const result = runToolingScript('evidence-verify.ts', process.cwd(), [
      '--decision-fixture-self-test-accepts',
    ]);
    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain('spec000_evidence_registry_self_test');
    expect(combinedOutput(result)).toContain('"pass":false');
  });

  it('records exists false for a missing package-script owner', () => {
    const evidence = { kind: 'static_validator' as const, command: 'pnpm definitely-missing' };
    const result = evaluateEvidence(
      'missing_owner',
      evidence,
      {},
      new Map([['pnpm definitely-missing', { exitCode: 0, output: '' }]]),
      undefined,
    );
    expect(commandOwnerExists(evidence.command, {})).toBe(false);
    expect(result).toMatchObject({ exists: false, executionStatus: 'missing', pass: false });
  });

  it('binds every executed command to at least one concrete evidence row', () => {
    const manifest = JSON.parse(readFileSync('evidence/manifest.json', 'utf8')) as EvidenceManifest;
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(validateEvidenceManifest(manifest, scripts)).toEqual([]);
    for (const command of manifest.executionOrder)
      expect(
        Object.values(manifest.evidence).some((evidence) => evidence.command === command),
      ).toBe(true);
  });

  it.each([
    'missing invariant',
    'invented invariant',
    'changed required kind',
    'rebound required command',
  ])('rejects manifest tampering: %s', (mutation) => {
    const manifest = JSON.parse(readFileSync('evidence/manifest.json', 'utf8')) as EvidenceManifest;
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    if (mutation === 'missing invariant') delete manifest.invariants['INV-000-018B'];
    if (mutation === 'invented invariant') manifest.invariants['INV-999-999'] = [];
    if (mutation === 'changed required kind')
      manifest.evidence.spec000_runtime_mode_fail_closed!.kind = 'static_validator';
    if (mutation === 'rebound required command')
      manifest.evidence.spec000_runtime_mode_fail_closed!.command = 'pnpm lint';
    expect(validateEvidenceManifest(manifest, scripts).length).toBeGreaterThan(0);
  });

  it('does not accept an automated test whose name only spoofs the evidence-ID suffix', () => {
    const result = evaluateEvidence(
      'spec000_runtime_mode_fail_closed',
      { kind: 'automated_test', command: 'pnpm test' },
      { test: 'vitest run' },
      new Map([['pnpm test', { exitCode: 0, output: '' }]]),
      {
        success: true,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [
          {
            assertionResults: [
              {
                fullName: 'maliciousspec000_runtime_mode_fail_closed',
                status: 'passed',
              },
            ],
          },
        ],
      },
    );
    expect(result).toMatchObject({ executionStatus: 'missing', exitCode: 0, pass: false });
  });

  it.each([
    ['pnpm lint', 'spec000_formatting_and_lint_policy'],
    ['pnpm build', 'spec000_production_builds_succeed'],
    ['pnpm db:validate', 'spec000_prisma_schema_validates_and_generates'],
  ])('forces aggregate failure when %s exits nonzero', (command, evidenceId) => {
    const result = runToolingScript('evidence-verify.ts', process.cwd(), [
      '--decision-fixture-failing-command',
      command,
    ]);
    const output = combinedOutput(result);
    expect(result.status).toBe(1);
    expect(output).toContain('"accepted":false');
    expect(output).toContain(evidenceId);
  });
});

/**
 * SPEC-001 evidence joins the frozen registry additively. These regressions prove the aggregate
 * stays fail-closed for the new rows: a dropped invariant, a retargeted command, a missing
 * earthquake identity or a missing R2 item must all be rejected.
 */
describe('SPEC-001 evidence registry remains fail-closed', () => {
  it('accepts the committed manifest and covers every frozen SPEC-001 identity', () => {
    const manifest = committedManifest();
    expect(validateEvidenceManifest(manifest, rootScripts())).toEqual([]);

    const invariantIds = Object.keys(manifest.invariants).filter((id) => id.startsWith('INV-001-'));
    expect(invariantIds).toHaveLength(46);
    expect(manifest.spec001RequiredEvidence?.earthquakeScenarios).toHaveLength(42);
    expect(manifest.spec001RequiredEvidence?.r2CleanIncorporation).toHaveLength(4);

    // Every declared identity is owned by a real, executable command in the execution order.
    const all = [
      ...invariantIds.flatMap((id) => manifest.invariants[id]!),
      ...(manifest.spec001RequiredEvidence?.earthquakeScenarios ?? []),
      ...(manifest.spec001RequiredEvidence?.r2CleanIncorporation ?? []),
    ];
    for (const id of all) {
      const evidence = manifest.evidence[id];
      expect(evidence, `${id} missing from evidence registry`).toBeDefined();
      expect(commandOwnerExists(evidence!.command, rootScripts()), id).toBe(true);
      expect(manifest.executionOrder).toContain(evidence!.command);
    }
  });

  it('rejects a dropped SPEC-001 invariant row', () => {
    const manifest = committedManifest();
    delete manifest.invariants['INV-001-024'];
    const errors = validateEvidenceManifest(manifest, rootScripts());
    expect(errors.some((error) => error.includes('critical invariant registry differs'))).toBe(
      true,
    );
  });

  it('rejects a SPEC-001 invariant retargeted at a different command', () => {
    const manifest = committedManifest();
    manifest.evidence['spec001_e33_real_restart_preserves_truth'] = {
      kind: 'automated_test',
      command: 'pnpm lint',
    };
    manifest.invariants['INV-001-033'] = ['spec001_e33_real_restart_preserves_truth'];
    const errors = validateEvidenceManifest(manifest, rootScripts());
    expect(errors.some((error) => error.includes('INV-001-033'))).toBe(true);
  });

  it('rejects a missing earthquake scenario identity', () => {
    const manifest = committedManifest();
    manifest.spec001RequiredEvidence!.earthquakeScenarios =
      manifest.spec001RequiredEvidence!.earthquakeScenarios.filter(
        (id) => id !== 'spec001_e28_append_only_runtime_role_bypass_attacks',
      );
    const errors = validateEvidenceManifest(manifest, rootScripts());
    expect(errors.some((error) => error.includes('earthquake evidence identities differ'))).toBe(
      true,
    );
  });

  it('rejects a missing R2 clean-incorporation item', () => {
    const manifest = committedManifest();
    manifest.spec001RequiredEvidence!.r2CleanIncorporation =
      manifest.spec001RequiredEvidence!.r2CleanIncorporation.filter(
        (id) => id !== 'spec001_raw_terms_cap_rejects_before_decode',
      );
    const errors = validateEvidenceManifest(manifest, rootScripts());
    expect(errors.some((error) => error.includes('r2 evidence identities differ'))).toBe(true);
  });

  it('rejects removal of the whole SPEC-001 declaration block', () => {
    const manifest = committedManifest();
    delete manifest.spec001RequiredEvidence;
    const errors = validateEvidenceManifest(manifest, rootScripts());
    expect(errors).toContain('manifest declares no spec001RequiredEvidence block');
  });

  it('treats a skipped SPEC-001 evidence test as a failure, not a pass', () => {
    const decision = evaluateEvidence(
      'spec001_e01_formal_birth',
      { kind: 'automated_test', command: 'pnpm test' },
      rootScripts(),
      new Map([['pnpm test', { exitCode: 0, output: '' }]]),
      {
        success: true,
        numPendingTests: 1,
        numTodoTests: 0,
        testResults: [
          { assertionResults: [{ fullName: 'suite spec001_e01_formal_birth', status: 'skipped' }] },
        ],
      },
    );
    expect(decision.pass).toBe(false);
    expect(decision.executionStatus).toBe('skipped');
  });
});
