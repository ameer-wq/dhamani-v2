import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { fail, pass, root } from './lib.ts';

const path = `${root}/.github/workflows/spec000.yml`;
const text = readFileSync(path, 'utf8');
const workflow = parse(text) as Record<string, unknown>;
const jobs = (workflow.jobs ?? {}) as Record<string, Record<string, unknown>>;
if (Object.keys(jobs).length === 0) fail('required workflow has zero jobs');
if (/paths-ignore:|continue-on-error:|strategy:\s*\n\s*matrix:/m.test(text))
  fail('CI bypass surface found');
for (const [id, job] of Object.entries(jobs)) {
  if (job.if !== undefined) fail(`whole-job if is forbidden: ${id}`);
  const steps = (job.steps ?? []) as Record<string, unknown>[];
  if (steps.length === 0 || steps.some((step) => step['continue-on-error'] !== undefined))
    fail(`required steps bypassable: ${id}`);
}
for (const command of [
  'pnpm install --frozen-lockfile',
  'docker compose up --detach --wait postgres',
  'pnpm ci:verify',
])
  if (!text.includes(command)) fail(`missing CI command ${command}`);
const aggregator = readFileSync(`${root}/tooling/scripts/evidence-verify.ts`, 'utf8');
for (const command of [
  'pnpm spec000:migration:verify',
  'pnpm spec000:readiness:verify',
  'pnpm mobile:doctor',
  'pnpm mobile:export:ci',
])
  if (!aggregator.includes(command)) fail(`aggregate omits required command ${command}`);
pass('spec000_required_ci_definition_fail_closed', {
  workflow: '.github/workflows/spec000.yml',
  job: 'SPEC-000 Required Gate',
  negativeFailurePropagationFixture: 'nonzero',
});
