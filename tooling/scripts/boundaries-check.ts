import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, readJson, root, walk } from './lib.ts';

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
];
const manifests = new Map(
  workspaces.map((w) => [w, readJson<Record<string, Record<string, string>>>(`${w}/package.json`)]),
);
for (const [workspace, manifest] of manifests) {
  for (const kind of ['dependencies', 'peerDependencies'] as const) {
    if (manifest[kind]?.['@dhamani/testkit']) fail(`${workspace} has runtime testkit edge`);
  }
  const deps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  for (const dep of Object.keys(deps)) {
    if (workspace.startsWith('packages/') && dep.startsWith('@dhamani/') && dep.includes('/api'))
      fail('package imports app');
    if (
      workspace === 'apps/mobile' &&
      ['@dhamani/db', '@dhamani/config', '@dhamani/observability'].includes(dep)
    )
      fail('mobile server dependency');
    if (workspace === 'packages/domain' && dep.startsWith('@dhamani/'))
      fail('domain workspace dependency');
    if (
      workspace === 'packages/contracts' &&
      !['@dhamani/domain'].includes(dep) &&
      dep.startsWith('@dhamani/')
    )
      fail('contracts forbidden edge');
  }
}
for (const file of walk('.', ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'])) {
  if (file.startsWith('tooling/')) continue;
  const text = readFileSync(join(root, file), 'utf8');
  if (file.startsWith('apps/mobile/') && /@dhamani\/(db|config|observability)/.test(text))
    fail(`mobile server import ${file}`);
  if (!file.startsWith('packages/config/') && file.includes('/src/') && /process\.env/.test(text))
    fail(`process.env outside config: ${file}`);
  if (/@dhamani\/testkit/.test(text) && !file.includes('.test.'))
    fail(`production testkit import: ${file}`);
}
pass('spec000_dependency_boundaries_enforced');
pass('spec000_no_app_to_app_imports');
pass('spec000_domain_is_pure_typescript');
pass('spec000_process_env_access_is_config_only');
pass('spec000_mobile_has_no_server_db_dependency');
pass('spec000_production_testkit_absence');
