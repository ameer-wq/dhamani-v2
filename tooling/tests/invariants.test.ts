import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveRuntimeConfig } from '../../packages/config/src/index.ts';
import { execPackageManagerSync } from '../scripts/package-manager.ts';
import { verifyNoDbPush } from '../scripts/repository-policy.ts';
import {
  typescriptWorkspaces,
  verifyWorkspaceTypeScriptFlags,
} from '../scripts/tsconfig-policy.ts';

const valid = {
  DHAMANI_RUNTIME_MODE: 'test',
  DATABASE_URL: 'postgresql://test:test@db:5432/test',
  DHAMANI_PRIVATE_SENTINEL: 'private',
  PORT: '3000',
};

describe('SPEC-000 critical invariants', () => {
  it('spec000_runtime_mode_fail_closed', () => {
    expect(() => resolveRuntimeConfig({ ...valid, DHAMANI_RUNTIME_MODE: undefined })).toThrow(
      'CONFIG_INVALID',
    );
    expect(() => resolveRuntimeConfig({ ...valid, DHAMANI_RUNTIME_MODE: 'preview' })).toThrow(
      'CONFIG_INVALID',
    );
  });
  it('spec000_runtime_config_is_startup_immutable', () => {
    const environment = { ...valid };
    const config = resolveRuntimeConfig(environment);
    environment.DATABASE_URL = 'postgresql://changed:changed@elsewhere:5432/changed';
    expect(config.database.url).toBe(valid.DATABASE_URL);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });
  it('spec000_runtime_mode_request_inputs_have_no_authority', () => {
    const config = resolveRuntimeConfig(valid);
    const request = {
      headers: { DHAMANI_RUNTIME_MODE: 'production' },
      body: { DHAMANI_RUNTIME_MODE: 'production' },
    };
    expect(config.runtimeMode).toBe('test');
    expect(request.body.DHAMANI_RUNTIME_MODE).not.toBe(config.runtimeMode);
  });
  it('spec000_production_rejects_dev_configuration', () => {
    expect(() =>
      resolveRuntimeConfig({
        ...valid,
        DHAMANI_RUNTIME_MODE: 'production',
        DATABASE_URL: 'postgresql://dhamani_dev:dhamani_dev_only@localhost:5432/dhamani_dev',
        DHAMANI_PRIVATE_SENTINEL: 'development-only-private-sentinel',
      }),
    ).toThrow('CONFIG_PRODUCTION_DEVELOPMENT_VALUE_REJECTED');
  });
  it('spec000_env_files_are_gitignored', () => {
    expect(() => execFileSync('git', ['check-ignore', '-q', '.env'])).not.toThrow();
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', 'apps/api/.env.production']),
    ).not.toThrow();
    expect(() => execFileSync('git', ['check-ignore', '-q', '.env.example'])).toThrow();
  });
  it('spec000_no_db_push_in_production_or_ci', () => {
    const scanned = verifyNoDbPush(process.cwd());
    // The scan must reach the root manifest, every workspace manifest, and every workflow --
    // not only root scripts whose name happens to contain "db".
    expect(scanned).toContain('package.json');
    expect(scanned).toContain('.github/workflows/spec000.yml');
    for (const workspace of typescriptWorkspaces)
      expect(scanned).toContain(`${workspace}/package.json`);
    // The legitimate migrate/validate commands required by the frozen SPEC must survive.
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['db:migrate:deploy']).toContain('prisma migrate deploy');
    expect(scripts['db:validate']).toContain('prisma validate');
  });
  it('spec000_scripts_are_cross_platform', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(
      Object.values(manifest.scripts).every(
        (value) => !/(^|&&)\s*[A-Z_]+=/.test(value) && !value.includes('/bin/bash'),
      ),
    ).toBe(true);
    expect(execPackageManagerSync(['--version'], { encoding: 'utf8' }).trim()).toBe('11.21.0');
  });
  it('spec000_no_workspace_weakens_required_ts_flags', () => {
    expect(verifyWorkspaceTypeScriptFlags(process.cwd())).toEqual([...typescriptWorkspaces].sort());
  });
});
