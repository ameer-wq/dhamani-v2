import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { fail, pass, readJson, root } from './lib.ts';

type Step = Record<string, unknown>;
type Job = Record<string, unknown> & { steps?: Step[] };
type Workflow = Record<string, unknown> & { jobs?: Record<string, Job> };

const requiredCommands = [
  'pnpm install --frozen-lockfile',
  'docker compose up --detach --wait postgres',
  'pnpm ci:verify',
] as const;
const requiredAggregatorCommands = [
  'pnpm spec000:migration:verify',
  'pnpm spec000:readiness:verify',
  'pnpm mobile:doctor',
  'pnpm mobile:export:ci',
  'pnpm spec000:build-artifacts:verify',
] as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

export function validateCiDefinition(
  workflowText: string,
  aggregatorText: string,
  evidenceManifestText: string,
): void {
  const workflow = asRecord(parse(workflowText), 'workflow') as Workflow;
  const triggers = asRecord(workflow.on, 'on');
  const pullRequest = asRecord(triggers.pull_request, 'on.pull_request');
  if ('paths' in pullRequest || 'paths-ignore' in pullRequest)
    throw new Error('pull_request path filters are forbidden');
  if ('branches-ignore' in pullRequest)
    throw new Error('pull_request branches-ignore is forbidden');
  const branchValue = pullRequest.branches;
  const branches = Array.isArray(branchValue) ? branchValue : [branchValue];
  if (!branches.includes('main')) throw new Error('pull_request must target main');

  const permissions = asRecord(workflow.permissions, 'permissions');
  if (permissions.contents !== 'read') throw new Error('workflow contents permission must be read');
  if (Object.entries(permissions).some(([name, value]) => name !== 'contents' && value === 'write'))
    throw new Error('workflow must not grant write permission');

  const jobs = workflow.jobs ?? {};
  if (Object.keys(jobs).length === 0) throw new Error('required workflow has zero jobs');
  let requiredJob: Job | undefined;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.if !== undefined) throw new Error(`whole-job if is forbidden: ${id}`);
    if (asRecord(job.strategy ?? {}, `strategy for ${id}`).matrix !== undefined)
      throw new Error(`dynamic matrix is forbidden: ${id}`);
    const steps = job.steps ?? [];
    if (steps.length === 0) throw new Error(`required job has zero steps: ${id}`);
    for (const step of steps) {
      if (step.if !== undefined) throw new Error(`step-level if is forbidden: ${id}`);
      if (step['continue-on-error'] !== undefined)
        throw new Error(`continue-on-error is forbidden: ${id}`);
    }
    if (job.name === 'SPEC-000 Required Gate') requiredJob = job;
  }
  if (!requiredJob) throw new Error('SPEC-000 Required Gate job missing');
  const runSteps = (requiredJob.steps ?? [])
    .map((step) => step.run)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim());
  for (const command of requiredCommands)
    if (!runSteps.includes(command)) throw new Error(`missing unconditional CI command ${command}`);
  if (!aggregatorText.includes('manifest.executionOrder'))
    throw new Error('aggregator does not consume manifest executionOrder');
  const evidenceManifest = JSON.parse(evidenceManifestText) as { executionOrder?: string[] };
  for (const command of requiredAggregatorCommands)
    if (!evidenceManifest.executionOrder?.includes(command))
      throw new Error(`aggregate omits required command ${command}`);
}

function fixtureArguments(): {
  workflowPath?: string | undefined;
  aggregatorPath?: string | undefined;
  manifestPath?: string | undefined;
} {
  const workflowIndex = process.argv.indexOf('--fixture-workflow');
  const aggregatorIndex = process.argv.indexOf('--fixture-aggregator');
  const manifestIndex = process.argv.indexOf('--fixture-manifest');
  return {
    workflowPath: workflowIndex >= 0 ? process.argv[workflowIndex + 1] : undefined,
    aggregatorPath: aggregatorIndex >= 0 ? process.argv[aggregatorIndex + 1] : undefined,
    manifestPath: manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined,
  };
}

function runNegativeFixtures(
  workflowText: string,
  aggregatorText: string,
  evidenceManifestText: string,
) {
  const base = asRecord(parse(workflowText), 'workflow') as Workflow;
  const mutate = (change: (workflow: Workflow) => void): string => {
    const workflow = structuredClone(base);
    change(workflow);
    return stringify(workflow);
  };
  const requiredJob = (workflow: Workflow): Job => {
    const job = Object.values(workflow.jobs ?? {}).find(
      (candidate) => candidate.name === 'SPEC-000 Required Gate',
    );
    if (!job) throw new Error('fixture required job missing');
    return job;
  };
  const requiredStep = (workflow: Workflow): Step => {
    const step = (requiredJob(workflow).steps ?? []).find(
      (candidate) => candidate.run === 'pnpm ci:verify',
    );
    if (!step) throw new Error('fixture required step missing');
    return step;
  };
  const fixtures = [
    {
      name: 'step-level-if',
      text: mutate((workflow) => {
        requiredStep(workflow).if = "github.actor != 'codex-bot'";
      }),
      message: 'step-level if is forbidden',
    },
    {
      name: 'pull-request-paths',
      text: mutate((workflow) => {
        asRecord(asRecord(workflow.on, 'on').pull_request, 'pull_request').paths = ['apps/**'];
      }),
      message: 'path filters are forbidden',
    },
    {
      name: 'pull-request-retargeted',
      text: mutate((workflow) => {
        asRecord(asRecord(workflow.on, 'on').pull_request, 'pull_request').branches = ['develop'];
      }),
      message: 'must target main',
    },
    {
      name: 'failure-masked',
      text: mutate((workflow) => {
        requiredStep(workflow).run = 'pnpm ci:verify; exit 0';
      }),
      message: 'missing unconditional CI command',
    },
  ];
  const temporary = mkdtempSync(join(tmpdir(), 'dhamani-ci-definition-'));
  try {
    const aggregatorPath = join(temporary, 'aggregator.ts');
    const manifestPath = join(temporary, 'manifest.json');
    writeFileSync(aggregatorPath, aggregatorText);
    writeFileSync(manifestPath, evidenceManifestText);
    return fixtures.map((fixture) => {
      const workflowPath = join(temporary, `${fixture.name}.yml`);
      writeFileSync(workflowPath, fixture.text);
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          fileURLToPath(import.meta.url),
          '--fixture-workflow',
          workflowPath,
          '--fixture-aggregator',
          aggregatorPath,
          '--fixture-manifest',
          manifestPath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status !== 1 || !output.includes(fixture.message))
        throw new Error(
          `CI negative fixture ${fixture.name} did not fail closed: status=${String(result.status)} output=${output}`,
        );
      return { name: fixture.name, exitCode: result.status };
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  const fixture = fixtureArguments();
  const workflowPath = fixture.workflowPath ?? join(root, '.github/workflows/spec000.yml');
  const aggregatorPath = fixture.aggregatorPath ?? join(root, 'tooling/scripts/evidence-verify.ts');
  const manifestPath = fixture.manifestPath ?? join(root, 'evidence/manifest.json');
  const workflowText = readFileSync(workflowPath, 'utf8');
  const aggregatorText = readFileSync(aggregatorPath, 'utf8');
  const evidenceManifestText = readFileSync(manifestPath, 'utf8');
  validateCiDefinition(workflowText, aggregatorText, evidenceManifestText);
  if (fixture.workflowPath) {
    pass('spec000_required_ci_definition_fail_closed', { fixture: workflowPath });
  } else {
    const packageManifest = readJson<{ scripts: Record<string, string> }>('package.json');
    const exactScripts: Record<string, string> = {
      'spec000:evidence:verify':
        'node --experimental-strip-types tooling/scripts/evidence-verify.ts',
      'ci:verify': 'node --experimental-strip-types tooling/scripts/evidence-verify.ts',
      'spec000:zero-product-logic:verify':
        'node --experimental-strip-types tooling/scripts/zero-product-verify.ts',
      'toolchain:verify': 'node --experimental-strip-types tooling/scripts/toolchain-verify.ts',
      'spec000:ci-definition:verify':
        'node --experimental-strip-types tooling/scripts/ci-definition-verify.ts',
    };
    for (const [name, expected] of Object.entries(exactScripts))
      if (packageManifest.scripts[name] !== expected)
        throw new Error(`${name} can bypass the required verifier mode`);
    pass('spec000_required_ci_definition_fail_closed', {
      workflow: '.github/workflows/spec000.yml',
      job: 'SPEC-000 Required Gate',
      negativeFixtures: runNegativeFixtures(workflowText, aggregatorText, evidenceManifestText),
    });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
