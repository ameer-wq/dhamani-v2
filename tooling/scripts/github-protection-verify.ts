import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fail, pass } from './lib.ts';

type Protection = {
  required_status_checks?: { strict?: boolean; contexts?: string[] };
  enforce_admins?: { enabled?: boolean };
  required_pull_request_reviews?: unknown;
  allow_force_pushes?: { enabled?: boolean };
  allow_deletions?: { enabled?: boolean };
};
const artifactPath = 'evidence/external/github-main-protection.json';
let protection: Protection;
if (process.argv.includes('--collect')) {
  try {
    protection = JSON.parse(
      execFileSync('gh', ['api', 'repos/ameer-wq/dhamani-v2/branches/main/protection'], {
        encoding: 'utf8',
      }),
    ) as Protection;
  } catch (error) {
    fail(`branch protection inaccessible: ${String(error)}`);
  }
  mkdirSync('evidence/external', { recursive: true });
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        repository: 'ameer-wq/dhamani-v2',
        branch: 'main',
        collectionCommand: 'gh api repos/ameer-wq/dhamani-v2/branches/main/protection',
        protection,
      },
      null,
      2,
    ),
  );
} else {
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      repository: string;
      branch: string;
      collectionCommand: string;
      protection: Protection;
    };
    if (
      artifact.repository !== 'ameer-wq/dhamani-v2' ||
      artifact.branch !== 'main' ||
      artifact.collectionCommand !== 'gh api repos/ameer-wq/dhamani-v2/branches/main/protection'
    )
      fail('branch protection artifact provenance mismatch');
    protection = artifact.protection;
  } catch (error) {
    fail(`branch protection artifact missing or invalid: ${String(error)}`);
  }
}
if (protection.required_pull_request_reviews == null) fail('pull request reviews not required');
if (protection.required_status_checks?.strict !== true) fail('strict status checks not enabled');
if (!protection.required_status_checks.contexts?.includes('SPEC-000 Required Gate'))
  fail('required check context missing');
if (protection.enforce_admins?.enabled !== true) fail('admin enforcement disabled');
if (protection.allow_force_pushes?.enabled !== false) fail('force pushes not disabled');
if (protection.allow_deletions?.enabled !== false) fail('branch deletion not disabled');
pass('spec000_github_branch_protection_verified', {
  branch: 'main',
  context: 'SPEC-000 Required Gate',
});
