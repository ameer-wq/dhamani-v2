import { describe, expect, it } from 'vitest';
import {
  queryGitHubProtection,
  validateGitHubProtection,
  type Protection,
} from '../scripts/github-protection-core.ts';

function validProtection(): Protection {
  return {
    required_status_checks: { strict: true, contexts: ['SPEC-000 Required Gate'] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {},
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

describe('live GitHub branch-protection gate decisions', () => {
  it('accepts the complete frozen protection shape', () => {
    expect(() => validateGitHubProtection(validProtection())).not.toThrow();
  });

  const invalidCases: Array<[string, (value: Protection) => void]> = [
    [
      'pull request reviews absent',
      (value: Protection) => delete value.required_pull_request_reviews,
    ],
    ['required status checks absent', (value: Protection) => delete value.required_status_checks],
    [
      'strict status setting absent',
      (value) => {
        delete value.required_status_checks!.strict;
      },
    ],
    [
      'strict status checks false',
      (value: Protection) => {
        value.required_status_checks!.strict = false;
      },
    ],
    [
      'required contexts absent',
      (value) => {
        delete value.required_status_checks!.contexts;
      },
    ],
    [
      'required context absent',
      (value: Protection) => {
        value.required_status_checks!.contexts = [];
      },
    ],
    [
      'admin enforcement absent',
      (value) => {
        delete value.enforce_admins;
      },
    ],
    [
      'admin enforcement false',
      (value: Protection) => {
        value.enforce_admins!.enabled = false;
      },
    ],
    [
      'force-push setting absent',
      (value) => {
        delete value.allow_force_pushes;
      },
    ],
    [
      'force pushes enabled',
      (value: Protection) => {
        value.allow_force_pushes!.enabled = true;
      },
    ],
    [
      'deletion setting absent',
      (value) => {
        delete value.allow_deletions;
      },
    ],
    [
      'deletions enabled',
      (value: Protection) => {
        value.allow_deletions!.enabled = true;
      },
    ],
  ];

  it.each(invalidCases)('rejects %s', (_name, mutate) => {
    const protection = validProtection();
    mutate(protection);
    expect(() => validateGitHubProtection(protection)).toThrow();
  });

  it.each(['unreachable API', 'unauthenticated gh'])('rejects %s query failure', (reason) => {
    expect(() =>
      queryGitHubProtection(() => {
        throw new Error(reason);
      }),
    ).toThrow('inaccessible or unauthenticated');
  });

  it('pins the live API query to github.com', () => {
    const result = queryGitHubProtection((executable, args) => {
      expect(executable).toBe('gh');
      expect(args).toEqual([
        'api',
        '--hostname',
        'github.com',
        'repos/ameer-wq/dhamani-v2/branches/main/protection',
      ]);
      return JSON.stringify(validProtection());
    });
    expect(() => validateGitHubProtection(result.protection)).not.toThrow();
  });
});
