import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, readJson, root } from './lib.ts';
import { spawnPackageManagerSync } from './package-manager.ts';
import {
  aggregatePasses,
  evaluateEvidence,
  registrySelfTestFixtures,
  registrySelfTestResult,
  summarizeRegistrySelfTest,
  validateEvidenceManifest,
  type CommandResult,
  type EvidenceManifest,
  type EvidenceResult,
  type VitestReport,
} from './evidence-core.ts';

const selfEvidenceIds = new Set([
  'spec000_evidence_registry_matches_executed_results',
  'spec000_evidence_registry_self_test',
]);

function syntheticVitest(manifest: EvidenceManifest): VitestReport {
  const assertionResults = Object.entries(manifest.evidence)
    .filter(([, evidence]) => evidence.kind === 'automated_test')
    .map(([id]) => ({ fullName: `synthetic ${id}`, status: 'passed' }));
  return {
    success: true,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{ assertionResults }],
  };
}

function selectedEvidenceEntries(manifest: EvidenceManifest, repositoryLocal: boolean) {
  return Object.entries(manifest.evidence).filter(
    ([id, evidence]) =>
      !selfEvidenceIds.has(id) && (!repositoryLocal || evidence.kind !== 'external_platform_check'),
  );
}

function runDecisionFixture(targetCommand: string): never {
  const manifest = readJson<EvidenceManifest>('evidence/manifest.json');
  const scripts = readJson<{ scripts: Record<string, string> }>('package.json').scripts;
  if (!['pnpm lint', 'pnpm build', 'pnpm db:validate'].includes(targetCommand)) {
    console.error(JSON.stringify({ status: 'fixture-error', targetCommand }));
    process.exit(2);
  }
  const outcomes = new Map<string, CommandResult>(
    manifest.executionOrder.map((command) => [command, { exitCode: 0, output: '' }]),
  );
  outcomes.set(targetCommand, { exitCode: 9, output: 'forced negative fixture' });
  const vitest = syntheticVitest(manifest);
  const entries = selectedEvidenceEntries(manifest, false);
  const results = entries.map(([id, evidence]) =>
    evaluateEvidence(id, evidence, scripts, outcomes, vitest),
  );
  const selfTest = registrySelfTestResult(manifest, scripts);
  const manifestErrors = validateEvidenceManifest(manifest, scripts);
  const accepted = aggregatePasses(
    results,
    outcomes,
    manifest.executionOrder,
    manifestErrors,
    selfTest.pass,
    vitest,
  );
  console.error(
    JSON.stringify({ targetCommand, accepted, results: results.filter((row) => !row.pass) }),
  );
  process.exit(accepted ? 2 : 1);
}

function runSelfTestAcceptanceFixture(): never {
  const manifest = readJson<EvidenceManifest>('evidence/manifest.json');
  const scripts = readJson<{ scripts: Record<string, string> }>('package.json').scripts;
  const fixtures = registrySelfTestFixtures(manifest, scripts);
  fixtures[0] = {
    ...fixtures[0]!,
    rejected: false,
    reason: 'deliberately accepted regression fixture',
  };
  const selfTest = summarizeRegistrySelfTest(fixtures);
  const row: EvidenceResult = {
    evidenceId: 'spec000_evidence_registry_self_test',
    exists: true,
    executionStatus: selfTest.pass ? 'passed' : 'failed',
    exitCode: selfTest.pass ? 0 : 1,
    pass: selfTest.pass,
    command: 'pnpm spec000:evidence:verify',
    details: selfTest.fixtures,
  };
  console.error(JSON.stringify(row));
  process.exit(row.pass ? 2 : 1);
}

const fixtureIndex = process.argv.indexOf('--decision-fixture-failing-command');
if (fixtureIndex >= 0) runDecisionFixture(process.argv[fixtureIndex + 1] ?? '');
if (process.argv.includes('--decision-fixture-self-test-accepts')) runSelfTestAcceptanceFixture();

const completeWithLiveExternal = process.argv.includes('--complete-with-live-external');
const repositoryLocal = !completeWithLiveExternal;
if (
  process.argv.some(
    (argument) => argument.startsWith('--') && argument !== '--complete-with-live-external',
  )
)
  fail('unsupported evidence verifier argument');

mkdirSync(join(root, 'evidence/results'), { recursive: true });
rmSync(join(root, 'evidence/results/vitest.json'), { force: true });
rmSync(join(root, 'evidence/results/spec000-results.json'), { force: true });
rmSync(join(root, 'evidence/results/github-main-protection.json'), { force: true });
const manifest = readJson<EvidenceManifest>('evidence/manifest.json');
const scripts = readJson<{ scripts: Record<string, string> }>('package.json').scripts;
const manifestErrors = validateEvidenceManifest(manifest, scripts);
if (manifestErrors.length > 0) {
  writeFileSync(
    join(root, 'evidence/results/spec000-results.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope: repositoryLocal ? 'repository-local' : 'complete-with-live-external',
        completeCriticalEvidence: false,
        manifestErrors,
        results: [],
      },
      null,
      2,
    ),
  );
  fail(`evidence manifest invalid: ${manifestErrors.join('; ')}`);
}

const entries = selectedEvidenceEntries(manifest, repositoryLocal);
const selectedCommands = manifest.executionOrder.filter((command) =>
  entries.some(([, evidence]) => evidence.command === command),
);
const commandResults = new Map<string, CommandResult>();
for (const command of selectedCommands) {
  const args = command.replace(/^pnpm\s+/, '').split(/\s+/);
  const result = spawnPackageManagerSync(args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const exitCode = result.status ?? 1;
  commandResults.set(command, { exitCode, output });
  if (exitCode === 0) console.log(output);
  else console.error(output);
}

let vitest: VitestReport | undefined;
try {
  vitest = JSON.parse(
    readFileSync(join(root, 'evidence/results/vitest.json'), 'utf8'),
  ) as VitestReport;
} catch {
  vitest = undefined;
}
const results: EvidenceResult[] = entries.map(([id, evidence]) =>
  evaluateEvidence(id, evidence, scripts, commandResults, vitest),
);
const selfTest = registrySelfTestResult(manifest, scripts);
results.push({
  evidenceId: 'spec000_evidence_registry_self_test',
  exists: scripts['spec000:evidence:verify'] !== undefined,
  executionStatus: selfTest.pass ? 'passed' : 'failed',
  exitCode: selfTest.pass ? 0 : 1,
  pass: selfTest.pass,
  command: 'pnpm spec000:evidence:verify',
  details: selfTest.fixtures,
});
const aggregateBeforeOwnRow = aggregatePasses(
  results,
  commandResults,
  selectedCommands,
  manifestErrors,
  selfTest.pass,
  vitest,
);
results.push({
  evidenceId: 'spec000_evidence_registry_matches_executed_results',
  exists: scripts['spec000:evidence:verify'] !== undefined,
  executionStatus: aggregateBeforeOwnRow ? 'passed' : 'failed',
  exitCode: aggregateBeforeOwnRow ? 0 : 1,
  pass: aggregateBeforeOwnRow,
  command: 'pnpm spec000:evidence:verify',
});
const allPassed = results.every((result) => result.pass) && aggregateBeforeOwnRow;
const deferredExternalEvidenceIds = repositoryLocal
  ? Object.entries(manifest.evidence)
      .filter(([, evidence]) => evidence.kind === 'external_platform_check')
      .map(([id]) => id)
  : [];
writeFileSync(
  join(root, 'evidence/results/spec000-results.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scope: repositoryLocal ? 'repository-local' : 'complete-with-live-external',
      completeCriticalEvidence: !repositoryLocal && allPassed,
      deferredExternalEvidenceIds,
      commandResults: Object.fromEntries(
        [...commandResults].map(([command, result]) => [command, { exitCode: result.exitCode }]),
      ),
      results,
    },
    null,
    2,
  ),
);
if (!allPassed)
  fail(
    `evidence failed: ${results
      .filter((result) => !result.pass)
      .map((result) => result.evidenceId)
      .join(', ')}`,
  );
pass('spec000_evidence_registry_self_test', { fixtures: selfTest.fixtures });
pass('spec000_evidence_registry_matches_executed_results', {
  count: results.length,
  scope: repositoryLocal ? 'repository-local' : 'complete-with-live-external',
  deferredExternalEvidenceIds,
});
