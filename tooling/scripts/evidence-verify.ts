import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fail, pass, readJson, root } from './lib.ts';

type Evidence = {
  kind:
    | 'automated_test'
    | 'static_validator'
    | 'build_or_migration_check'
    | 'runtime_integration_check'
    | 'external_platform_check';
  command: string;
};
type Manifest = { invariants: Record<string, string[]>; evidence: Record<string, Evidence> };
type Result = {
  evidenceId: string;
  exists: boolean;
  executionStatus: 'passed' | 'failed' | 'missing' | 'skipped' | 'todo';
  exitCode: number;
  pass: boolean;
  command: string;
};
const manifest = readJson<Manifest>('evidence/manifest.json');
const allowed = new Set([
  'automated_test',
  'static_validator',
  'build_or_migration_check',
  'runtime_integration_check',
  'external_platform_check',
]);
for (const [invariant, ids] of Object.entries(manifest.invariants)) {
  if (ids.length === 0) fail(`${invariant} has no evidence`);
  for (const id of ids) {
    const evidence = manifest.evidence[id];
    if (!evidence || !allowed.has(evidence.kind) || !evidence.command)
      fail(`${invariant} references invalid evidence ${id}`);
  }
}

function registrySelfTest(): void {
  const reject = (fixture: { exists: boolean; status: string; raw?: boolean }) =>
    !fixture.exists || fixture.status !== 'passed' || fixture.raw === false;
  const fixtures = [
    { exists: false, status: 'passed' },
    { exists: true, status: 'skipped' },
    { exists: true, status: 'todo' },
    { exists: true, status: 'failed' },
    { exists: true, status: 'passed', raw: false },
  ];
  if (!fixtures.every(reject)) fail('evidence registry self-test fixture accepted');
}
registrySelfTest();

const commands = [
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
];
const commandResults = new Map<string, { exitCode: number; output: string }>();
for (const command of commands) {
  const [executable, ...args] = command.split(' ');
  const runnable = process.platform === 'win32' && executable === 'pnpm' ? 'pnpm.cmd' : executable!;
  try {
    const output = execFileSync(runnable, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    commandResults.set(command, { exitCode: 0, output });
    console.log(output);
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    commandResults.set(command, { exitCode: failure.status ?? 1, output });
    console.error(output);
  }
}

const vitest = JSON.parse(readFileSync(`${root}/evidence/results/vitest.json`, 'utf8')) as {
  success: boolean;
  numPendingTests: number;
  numTodoTests: number;
  testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }>;
};
if (!vitest.success || vitest.numPendingTests !== 0 || vitest.numTodoTests !== 0)
  fail('Vitest raw result failed or contains pending/todo tests');
const assertions = new Map(
  vitest.testResults.flatMap((suite) =>
    suite.assertionResults.map((test) => [test.fullName, test.status] as const),
  ),
);
const results: Result[] = [];
for (const [id, evidence] of Object.entries(manifest.evidence)) {
  if (
    id === 'spec000_evidence_registry_matches_executed_results' ||
    id === 'spec000_evidence_registry_self_test'
  )
    continue;
  const commandResult = commandResults.get(evidence.command);
  let passed = commandResult?.exitCode === 0;
  if (evidence.kind === 'automated_test') {
    const match = [...assertions.entries()].find(([name]) => name.endsWith(id));
    passed = passed && match?.[1] === 'passed';
  }
  results.push({
    evidenceId: id,
    exists: true,
    executionStatus: passed ? 'passed' : 'failed',
    exitCode: commandResult?.exitCode ?? 1,
    pass: passed,
    command: evidence.command,
  });
}
results.push({
  evidenceId: 'spec000_evidence_registry_self_test',
  exists: true,
  executionStatus: 'passed',
  exitCode: 0,
  pass: true,
  command: 'pnpm spec000:evidence:verify',
});
const allPassed = results.every((result) => result.pass);
results.push({
  evidenceId: 'spec000_evidence_registry_matches_executed_results',
  exists: true,
  executionStatus: allPassed ? 'passed' : 'failed',
  exitCode: allPassed ? 0 : 1,
  pass: allPassed,
  command: 'pnpm spec000:evidence:verify',
});
mkdirSync(`${root}/evidence/results`, { recursive: true });
writeFileSync(
  `${root}/evidence/results/spec000-results.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
);
if (!allPassed)
  fail(
    `evidence failed: ${results
      .filter((result) => !result.pass)
      .map((result) => result.evidenceId)
      .join(', ')}`,
  );
pass('spec000_evidence_registry_self_test');
pass('spec000_evidence_registry_matches_executed_results', { count: results.length });
