import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, root } from './lib.ts';
import { execPackageManagerSync } from './package-manager.ts';

type RepositorySnapshot = {
  porcelain: string;
  trackedDiff: string;
  untrackedHashes: Record<string, string>;
};

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

function snapshot(): RepositorySnapshot {
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .sort();
  return {
    porcelain: git(['status', '--porcelain=v1', '--untracked-files=all']),
    trackedDiff: git(['diff', '--binary', 'HEAD', '--']),
    untrackedHashes: Object.fromEntries(
      untracked.map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(root, file)))
          .digest('hex'),
      ]),
    ),
  };
}

const before = snapshot();
try {
  execPackageManagerSync(['exec', 'turbo', 'run', 'build'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
} catch (error) {
  fail(`workspace production build failed: ${String(error)}`);
}
const after = snapshot();
if (JSON.stringify(after) !== JSON.stringify(before))
  fail(
    `production build changed repository state: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
pass('spec000_production_builds_succeed');
pass('spec000_generated_artifacts_are_ignored_and_clean');
