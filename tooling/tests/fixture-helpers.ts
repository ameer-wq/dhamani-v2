import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const repositoryRoot = process.cwd();
const workspaces = [
  'apps/api',
  'apps/mobile',
  'apps/admin',
  'packages/domain',
  'packages/contracts',
  'packages/config',
  'packages/db',
  'packages/observability',
  'packages/testkit',
] as const;

export function copyRelative(targetRoot: string, relativePath: string): void {
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(repositoryRoot, relativePath), target);
}

export function createProductionFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'dhamani-production-fixture-'));
  const inventory = JSON.parse(
    readFileSync(
      join(repositoryRoot, 'tooling/boundaries/production-source-inventory.json'),
      'utf8',
    ),
  ) as { production: string[] };
  copyRelative(fixture, 'tooling/boundaries/production-source-inventory.json');
  copyRelative(fixture, 'packages/db/prisma/schema.prisma');
  for (const file of inventory.production) copyRelative(fixture, file);
  for (const workspace of workspaces) copyRelative(fixture, `${workspace}/package.json`);
  // A partially copied fixture would make the verifier fail for the wrong reason, so an
  // incomplete copy is surfaced here rather than misattributed to the check under test.
  for (const file of inventory.production)
    if (!existsSync(join(fixture, file)))
      throw new Error(`production fixture is incomplete: ${file} was not copied`);
  return fixture;
}

export function removeFixture(fixture: string): void {
  // A subprocess that has just exited can still hold handles briefly on Windows, which makes an
  // unguarded rmSync intermittently throw and turns a real result into an unexplained failure.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(fixture, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { timeout: 5000 });
    }
  }
}

export function writeRelative(fixture: string, relativePath: string, content: string): void {
  const target = join(fixture, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function readRelative(fixture: string, relativePath: string): string {
  return readFileSync(join(fixture, relativePath), 'utf8');
}

export function runToolingScript(
  script: string,
  cwd: string = repositoryRoot,
  args: readonly string[] = [],
) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(repositoryRoot, 'tooling/scripts', script), ...args],
    { cwd, encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024 },
  );
}

export function combinedOutput(result: { stdout?: string | null; stderr?: string | null }): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
