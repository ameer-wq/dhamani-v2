import { readFileSync } from 'node:fs';
import { fail, pass, readJson, root } from './lib.ts';

const manifest = readJson<{ packageManager: string; engines: { node: string; pnpm: string } }>(
  'package.json',
);
const expectedNode = readFileSync(`${root}/.nvmrc`, 'utf8').trim();
const node = process.version.slice(1);
const pnpm = process.env.npm_config_user_agent?.match(/pnpm\/([^\s]+)/)?.[1];
if (!pnpm) fail('pnpm version unavailable from package-manager execution context');
if (
  manifest.engines.node !== expectedNode ||
  node !== expectedNode ||
  manifest.engines.pnpm !== pnpm ||
  manifest.packageManager !== `pnpm@${pnpm}`
)
  fail(`toolchain mismatch node=${node} pnpm=${pnpm}`);
const rejects = (candidate: string) => candidate !== expectedNode;
if (!rejects('0.0.0')) fail('negative mismatched-version fixture was not rejected');
pass('spec000_toolchain_versions_are_enforced', { node, pnpm, negativeFixture: 'rejected' });
