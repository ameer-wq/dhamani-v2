import { execFileSync } from 'node:child_process';
import { fail, pass } from './lib.ts';

type Protection = {
  required_status_checks?: { strict?: boolean; contexts?: string[] };
  enforce_admins?: { enabled?: boolean };
  required_pull_request_reviews?: unknown;
  allow_force_pushes?: { enabled?: boolean };
  allow_deletions?: { enabled?: boolean };
};
let protection: Protection;
try {
  protection = JSON.parse(
    execFileSync('gh', ['api', 'repos/ameer-wq/dhamani-v2/branches/main/protection'], {
      encoding: 'utf8',
    }),
  ) as Protection;
} catch (error) {
  fail(`branch protection inaccessible: ${String(error)}`);
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
