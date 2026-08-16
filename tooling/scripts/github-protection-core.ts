import { execFileSync } from 'node:child_process';

export type Protection = {
  required_status_checks?: { strict?: boolean; contexts?: string[] };
  enforce_admins?: { enabled?: boolean };
  required_pull_request_reviews?: unknown;
  allow_force_pushes?: { enabled?: boolean };
  allow_deletions?: { enabled?: boolean };
};

export type GitHubRunner = (executable: string, args: readonly string[]) => string;

export function queryGitHubProtection(
  runner: GitHubRunner = (executable, args) =>
    execFileSync(executable, [...args], { encoding: 'utf8' }),
): { raw: string; protection: Protection } {
  let raw: string;
  try {
    raw = runner('gh', [
      'api',
      '--hostname',
      'github.com',
      'repos/ameer-wq/dhamani-v2/branches/main/protection',
    ]);
  } catch (error) {
    throw new Error(`branch protection inaccessible or unauthenticated: ${String(error)}`, {
      cause: error,
    });
  }
  try {
    return { raw, protection: JSON.parse(raw) as Protection };
  } catch (error) {
    throw new Error(`branch protection response is not valid JSON: ${String(error)}`, {
      cause: error,
    });
  }
}

export function validateGitHubProtection(protection: Protection): void {
  if (protection.required_pull_request_reviews == null)
    throw new Error('pull request reviews not required');
  if (protection.required_status_checks == null) throw new Error('required status checks missing');
  if (protection.required_status_checks.strict !== true)
    throw new Error('strict status checks not enabled');
  if (!protection.required_status_checks.contexts?.includes('SPEC-000 Required Gate'))
    throw new Error('required check context missing');
  if (protection.enforce_admins?.enabled !== true)
    throw new Error('admin enforcement disabled or missing');
  if (protection.allow_force_pushes?.enabled !== false)
    throw new Error('force pushes not disabled or ambiguous');
  if (protection.allow_deletions?.enabled !== false)
    throw new Error('branch deletion not disabled or ambiguous');
}
