import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, root } from './lib.ts';
import { queryGitHubProtection, validateGitHubProtection } from './github-protection-core.ts';

const evidenceId = 'spec000_github_branch_protection_verified';
const artifactPath = join(root, 'evidence/results/github-main-protection.json');
mkdirSync(join(root, 'evidence/results'), { recursive: true });

if (process.argv.length > 2) {
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        evidenceId,
        exists: true,
        generatedAt: new Date().toISOString(),
        repository: 'ameer-wq/dhamani-v2',
        branch: 'main',
        collectionCommand:
          'gh api --hostname github.com repos/ameer-wq/dhamani-v2/branches/main/protection',
        command: 'pnpm spec000:github-protection:verify',
        executionStatus: 'failed',
        exitCode: 1,
        pass: false,
        error: 'offline or fixture arguments are forbidden',
      },
      null,
      2,
    ),
  );
  fail('GitHub protection verifier accepts no offline or fixture arguments');
}

try {
  const { raw, protection } = queryGitHubProtection();
  validateGitHubProtection(protection);
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        evidenceId,
        exists: true,
        generatedAt: new Date().toISOString(),
        repository: 'ameer-wq/dhamani-v2',
        branch: 'main',
        collectionCommand:
          'gh api --hostname github.com repos/ameer-wq/dhamani-v2/branches/main/protection',
        command: 'pnpm spec000:github-protection:verify',
        executionStatus: 'passed',
        exitCode: 0,
        pass: true,
        rawResponse: JSON.parse(raw) as unknown,
      },
      null,
      2,
    ),
  );
  pass(evidenceId, { branch: 'main', context: 'SPEC-000 Required Gate', live: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        evidenceId,
        exists: true,
        generatedAt: new Date().toISOString(),
        repository: 'ameer-wq/dhamani-v2',
        branch: 'main',
        collectionCommand:
          'gh api --hostname github.com repos/ameer-wq/dhamani-v2/branches/main/protection',
        command: 'pnpm spec000:github-protection:verify',
        executionStatus: 'failed',
        exitCode: 1,
        pass: false,
        error: message,
      },
      null,
      2,
    ),
  );
  fail(message);
}
