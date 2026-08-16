import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fail, pass, readJson, root } from './lib.ts';

function verify(): { node: string; pnpm: string } {
  const manifest = readJson<{ packageManager: string; engines: { node: string; pnpm: string } }>(
    'package.json',
  );
  const expectedNode = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  const node = process.version.slice(1);
  const pnpm = process.env.npm_config_user_agent?.match(/pnpm\/([^\s]+)/)?.[1];
  if (!pnpm) throw new Error('pnpm version unavailable from package-manager execution context');
  if (
    manifest.engines.node !== expectedNode ||
    node !== expectedNode ||
    manifest.engines.pnpm !== pnpm ||
    manifest.packageManager !== `pnpm@${pnpm}`
  )
    throw new Error(`toolchain mismatch node=${node} pnpm=${pnpm}`);
  return { node, pnpm };
}

function runNegativeFixture(): void {
  const temporary = mkdtempSync(join(tmpdir(), 'dhamani-toolchain-'));
  try {
    writeFileSync(join(temporary, '.nvmrc'), '0.0.0\n');
    writeFileSync(
      join(temporary, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@0.0.0', engines: { node: '0.0.0', pnpm: '0.0.0' } }),
    );
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', fileURLToPath(import.meta.url), '--fixture-child'],
      { cwd: temporary, encoding: 'utf8', env: process.env },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 1 || !output.includes('toolchain mismatch'))
      throw new Error(
        `mismatched-version fixture did not fail closed: status=${String(result.status)}`,
      );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  const versions = verify();
  const fixtureChild = process.argv.includes('--fixture-child');
  if (fixtureChild) process.exit(0);
  runNegativeFixture();
  pass('spec000_toolchain_versions_are_enforced', {
    ...versions,
    negativeFixture: 'subprocess-rejected',
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
