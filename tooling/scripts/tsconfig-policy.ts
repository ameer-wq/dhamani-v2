import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

export const typescriptWorkspaces = [
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

export const requiredTypeScriptFlags = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'forceConsistentCasingInFileNames',
  'isolatedModules',
  'noUncheckedSideEffectImports',
] as const;

function discoverWorkspaces(repositoryRoot: string): string[] {
  return ['apps', 'packages']
    .flatMap((parent) => {
      const directory = join(repositoryRoot, parent);
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((name) => statSync(join(directory, name)).isDirectory())
        .filter((name) => existsSync(join(directory, name, 'package.json')))
        .map((name) => `${parent}/${name}`);
    })
    .sort();
}

export function verifyWorkspaceTypeScriptFlags(
  repositoryRoot: string,
  workspaces?: readonly string[],
): string[] {
  const selectedWorkspaces = workspaces ?? discoverWorkspaces(repositoryRoot);
  if (!workspaces) {
    const expected = [...typescriptWorkspaces].sort();
    if (JSON.stringify(selectedWorkspaces) !== JSON.stringify(expected))
      throw new Error(
        `TypeScript workspace topology differs: actual=${JSON.stringify(selectedWorkspaces)} expected=${JSON.stringify(expected)}`,
      );
  }
  const verified: string[] = [];
  for (const workspace of selectedWorkspaces) {
    const manifestPath = join(repositoryRoot, workspace, 'package.json');
    const configPath = join(repositoryRoot, workspace, 'tsconfig.json');
    if (!existsSync(manifestPath) || !existsSync(configPath))
      throw new Error(`TypeScript workspace config or manifest missing: ${workspace}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (!manifest.scripts?.typecheck)
      throw new Error(`TypeScript workspace lacks typecheck script: ${workspace}`);
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (raw.error) throw new Error(`cannot read ${workspace}/tsconfig.json`);
    const parsed = ts.parseJsonConfigFileContent(
      raw.config,
      ts.sys,
      dirname(configPath),
      {},
      configPath,
    );
    if (parsed.errors.length > 0)
      throw new Error(
        `cannot resolve ${workspace}/tsconfig.json: ${parsed.errors
          .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
          .join('; ')}`,
      );
    const options = parsed.options as Record<string, unknown>;
    for (const flag of requiredTypeScriptFlags)
      if (options[flag] !== true)
        throw new Error(`${workspace}/tsconfig.json weakens or omits ${flag}`);
    verified.push(workspace);
  }
  return verified;
}
