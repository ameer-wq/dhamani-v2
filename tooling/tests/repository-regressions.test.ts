import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { execPackageManagerSync } from '../scripts/package-manager.ts';
import { verifyAgentsDocumentsCommands, verifyNoDbPush } from '../scripts/repository-policy.ts';
import { combinedOutput, runToolingScript } from './fixture-helpers.ts';
import vitestConfig from '../../vitest.config.ts';

describe('repository policy regressions', () => {
  function dbPushFixture(): string {
    const fixture = mkdtempSync(join(tmpdir(), 'dhamani-db-push-'));
    mkdirSync(join(fixture, '.github/workflows'), { recursive: true });
    writeFileSync(join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({
        scripts: {
          'db:migrate:deploy': 'prisma migrate deploy --schema packages/db/prisma/schema.prisma',
          'db:validate': 'prisma validate --schema packages/db/prisma/schema.prisma',
        },
      }),
    );
    writeFileSync(
      join(fixture, '.github/workflows/check.yml'),
      'jobs:\n  check:\n    steps:\n      - run: pnpm test\n',
    );
    for (const workspace of ['apps/api', 'packages/db']) {
      mkdirSync(join(fixture, workspace), { recursive: true });
      writeFileSync(
        join(fixture, workspace, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc -b' } }),
      );
    }
    return fixture;
  }

  it('accepts a clean workspace graph that keeps the required migrate and validate commands', () => {
    const fixture = dbPushFixture();
    try {
      expect(verifyNoDbPush(fixture)).toEqual([
        'package.json',
        'apps/api/package.json',
        'packages/db/package.json',
        '.github/workflows/check.yml',
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ['root script', 'package.json', (fixture: string) => join(fixture, 'package.json')],
    [
      'workspace app script',
      'apps/api/package.json',
      (fixture: string) => join(fixture, 'apps/api/package.json'),
    ],
    [
      'workspace package script',
      'packages/db/package.json',
      (fixture: string) => join(fixture, 'packages/db/package.json'),
    ],
  ])('rejects db push introduced in a %s', (_label, location, manifestPath) => {
    const fixture = dbPushFixture();
    try {
      const path = manifestPath(fixture);
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        scripts: Record<string, string>;
      };
      manifest.scripts['schema:sync'] = 'prisma db push --accept-data-loss';
      writeFileSync(path, JSON.stringify(manifest));
      expect(() => verifyNoDbPush(fixture)).toThrow(
        `db push forbidden in ${location} script schema:sync`,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects db push introduced in a workflow run step', () => {
    const fixture = dbPushFixture();
    try {
      writeFileSync(
        join(fixture, '.github/workflows/check.yml'),
        'jobs:\n  check:\n    steps:\n      - run: pnpm prisma db push\n',
      );
      expect(() => verifyNoDbPush(fixture)).toThrow('db push forbidden in workflow');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('fails closed on a workspace pattern it cannot expand', () => {
    const fixture = dbPushFixture();
    try {
      writeFileSync(join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - "**/*"\n');
      expect(() => verifyNoDbPush(fixture)).toThrow('unsupported workspace pattern');
      writeFileSync(join(fixture, 'pnpm-workspace.yaml'), 'packages: []\n');
      expect(() => verifyNoDbPush(fixture)).toThrow('declares no package patterns');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('resolves every required AGENTS verification command', () => {
    expect(() => verifyAgentsDocumentsCommands(process.cwd())).not.toThrow();
  });

  it('pins LF checkout semantics through Git attributes on Windows and Unix', () => {
    const output = execFileSync('git', ['check-attr', 'eol', '--', 'package.json'], {
      encoding: 'utf8',
    });
    expect(output.trim()).toBe('package.json: eol: lf');
  });

  it('contains no stale Expo-major release-age exclusions', () => {
    const workspace = parse(readFileSync('pnpm-workspace.yaml', 'utf8')) as {
      minimumReleaseAgeExclude?: string[];
    };
    const mobile = JSON.parse(readFileSync('apps/mobile/package.json', 'utf8')) as {
      dependencies: { expo: string };
    };
    const expoMajor = mobile.dependencies.expo.split('.')[0];
    const stale = (workspace.minimumReleaseAgeExclude ?? []).filter(
      (entry) =>
        /^(?:@expo\/|babel-preset-expo@|expo(?:-|@))/.test(entry) &&
        /@(\d+)\./.exec(entry)?.[1] !== expoMajor &&
        !entry.startsWith('expo-doctor@'),
    );
    expect(stale).toEqual([]);
  });

  it('loads prisma.config.ts without an undeclared dotenv side effect', () => {
    expect(() =>
      execFileSync(process.execPath, ['--experimental-strip-types', 'prisma.config.ts'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
        },
      }),
    ).not.toThrow();
  });

  it('keeps Next generated type declarations byte-stable and outside formatting', () => {
    expect(readFileSync('.prettierignore', 'utf8').split(/\r?\n/)).toContain(
      'apps/admin/next-env.d.ts',
    );
    expect(readFileSync('apps/admin/next-env.d.ts', 'utf8')).toBe(
      '/// <reference types="next" />\n' +
        '/// <reference types="next/image-types/global" />\n' +
        'import "./.next/types/routes.d.ts";\n\n' +
        '// NOTE: This file should not be edited\n' +
        '// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n',
    );
  });

  it('keeps real integration timeout and hook budgets at or above 30 seconds', () => {
    expect(vitestConfig.test?.testTimeout).toBeGreaterThanOrEqual(30_000);
    expect(vitestConfig.test?.hookTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it('executes CI-definition verifier negative fixtures through the real CLI', () => {
    const result = runToolingScript('ci-definition-verify.ts');
    const output = combinedOutput(result);
    expect(result.status).toBe(0);
    for (const fixture of [
      'step-level-if',
      'pull-request-paths',
      'pull-request-retargeted',
      'failure-masked',
    ])
      expect(output).toContain(fixture);
  });

  it('executes the toolchain mismatched-version fixture through the real CLI', () => {
    const result = runToolingScript('toolchain-verify.ts');
    expect(result.status).toBe(0);
    expect(combinedOutput(result)).toContain('subprocess-rejected');
  });

  it('rejects a weakened effective workspace tsconfig through the real CLI', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dhamani-tsconfig-'));
    try {
      mkdirSync(join(fixture, 'packages/domain'), { recursive: true });
      writeFileSync(
        join(fixture, 'packages/domain/package.json'),
        JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      );
      writeFileSync(
        join(fixture, 'packages/domain/tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: false,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            noImplicitOverride: true,
            noFallthroughCasesInSwitch: true,
            forceConsistentCasingInFileNames: true,
            isolatedModules: true,
            noUncheckedSideEffectImports: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      mkdirSync(join(fixture, 'packages/domain/src'), { recursive: true });
      writeFileSync(join(fixture, 'packages/domain/src/index.ts'), 'export const marker = true;\n');
      const result = runToolingScript('tsconfig-flags-verify.ts', fixture, [
        '--fixture-workspace',
        'packages/domain',
      ]);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('weakens or omits strict');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('runs the production build and preserves the exact pre-build repository status', () => {
    const before = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    expect(() => execPackageManagerSync(['build'], { encoding: 'utf8' })).not.toThrow();
    const after = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    expect(after).toBe(before);
  }, 300_000);
});
