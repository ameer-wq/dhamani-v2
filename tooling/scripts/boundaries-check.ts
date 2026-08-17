import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { fail, pass, readJson, root } from './lib.ts';

type PackageManifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
type Inventory = { production: string[] };

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
const appWorkspaces = new Set(['apps/api', 'apps/mobile', 'apps/admin']);
const appPackages = new Set(['@dhamani/api', '@dhamani/mobile', '@dhamani/admin']);
const appPackageToWorkspace = new Map([
  ['@dhamani/api', 'apps/api'],
  ['@dhamani/mobile', 'apps/mobile'],
  ['@dhamani/admin', 'apps/admin'],
]);
const packageToWorkspace = new Map([
  ...appPackageToWorkspace,
  ['@dhamani/domain', 'packages/domain'],
  ['@dhamani/contracts', 'packages/contracts'],
  ['@dhamani/config', 'packages/config'],
  ['@dhamani/db', 'packages/db'],
  ['@dhamani/observability', 'packages/observability'],
  ['@dhamani/testkit', 'packages/testkit'],
]);
const serverPackages = new Set(['@dhamani/db', '@dhamani/config', '@dhamani/observability']);
const serverWorkspaces = new Set(['packages/db', 'packages/config', 'packages/observability']);
const runtimeAllowlists = new Map<string, Set<string>>([
  ['packages/domain', new Set()],
  ['packages/contracts', new Set(['@dhamani/domain', 'zod'])],
  ['packages/config', new Set(['zod'])],
  ['packages/db', new Set(['@dhamani/config', 'pg'])],
  ['packages/observability', new Set(['@dhamani/config', 'pino'])],
  ['packages/testkit', new Set()],
]);
const sourceWorkspaceAllowlists = new Map<string, Set<string>>([
  [
    'apps/api',
    new Set([
      'packages/domain',
      'packages/contracts',
      'packages/config',
      'packages/db',
      'packages/observability',
    ]),
  ],
  ['apps/mobile', new Set(['packages/domain', 'packages/contracts'])],
  ['apps/admin', new Set(['packages/domain', 'packages/contracts'])],
  ['packages/domain', new Set()],
  ['packages/contracts', new Set(['packages/domain'])],
  ['packages/config', new Set()],
  ['packages/db', new Set(['packages/config'])],
  ['packages/observability', new Set(['packages/config'])],
]);

function dependencyEntries(manifest: PackageManifest) {
  return (
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
  ).flatMap((kind) => Object.keys(manifest[kind] ?? {}).map((name) => ({ kind, name })));
}

function runtimeDependencyNames(manifest: PackageManifest): string[] {
  return (['dependencies', 'peerDependencies', 'optionalDependencies'] as const).flatMap((kind) =>
    Object.keys(manifest[kind] ?? {}),
  );
}

function importSpecifiers(source: ts.SourceFile): string[] {
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      values.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      values.push(node.arguments[0]!.text);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    )
      values.push(node.moduleReference.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

function readsProcessEnv(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === 'env' &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'process') ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'process' &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'env')
    )
      found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function workspaceFor(file: string): string {
  const workspace = workspaces.find((candidate) => file.startsWith(`${candidate}/`));
  if (!workspace) throw new Error(`production source outside declared workspace: ${file}`);
  return workspace;
}

function targetWorkspaceForSpecifier(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('@dhamani/')) {
    const packageName = specifier.split('/').slice(0, 2).join('/');
    return packageToWorkspace.get(packageName);
  }
  if (!specifier.startsWith('.')) return undefined;
  const resolved = relative(root, resolve(root, dirname(file), specifier)).replaceAll('\\', '/');
  return [...workspaces].find(
    (candidate) => resolved === candidate || resolved.startsWith(`${candidate}/`),
  );
}

function assertNoRuntimeCycles(manifests: Map<string, PackageManifest>): void {
  const packageToWorkspace = new Map(
    [...manifests].map(([workspace, manifest]) => [manifest.name, workspace]),
  );
  const graph = new Map(
    [...manifests].map(([workspace, manifest]) => [
      workspace,
      runtimeDependencyNames(manifest)
        .map((name) => packageToWorkspace.get(name))
        .filter((value): value is string => value !== undefined),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (workspace: string): void => {
    if (visiting.has(workspace))
      throw new Error(`runtime workspace dependency cycle at ${workspace}`);
    if (visited.has(workspace)) return;
    visiting.add(workspace);
    for (const dependency of graph.get(workspace) ?? []) visit(dependency);
    visiting.delete(workspace);
    visited.add(workspace);
  };
  for (const workspace of graph.keys()) visit(workspace);
}

function verify(): void {
  const discoveredWorkspaces = ['apps', 'packages']
    .flatMap((parent) =>
      readdirSync(join(root, parent))
        .filter((name) => statSync(join(root, parent, name)).isDirectory())
        .filter((name) => existsSync(join(root, parent, name, 'package.json')))
        .map((name) => `${parent}/${name}`),
    )
    .sort();
  if (JSON.stringify(discoveredWorkspaces) !== JSON.stringify([...workspaces].sort()))
    throw new Error(
      `workspace topology differs actual=${JSON.stringify(discoveredWorkspaces)} expected=${JSON.stringify([...workspaces].sort())}`,
    );
  const manifests = new Map(
    workspaces.map((workspace) => [
      workspace,
      readJson<PackageManifest>(`${workspace}/package.json`),
    ]),
  );
  for (const [workspace, manifest] of manifests) {
    const entries = dependencyEntries(manifest);
    for (const { kind, name } of entries) {
      if (name === '@dhamani/testkit' && kind !== 'devDependencies')
        throw new Error(`${workspace} has runtime testkit edge`);
      if (workspace.startsWith('packages/') && appPackages.has(name))
        throw new Error(`package imports app: ${workspace} -> ${name}`);
      if (appWorkspaces.has(workspace) && appPackages.has(name) && name !== manifest.name)
        throw new Error(`app imports app: ${workspace} -> ${name}`);
      if (workspace === 'apps/mobile' && serverPackages.has(name))
        throw new Error(`mobile server dependency: ${name}`);
      if (workspace === 'apps/admin' && serverPackages.has(name))
        throw new Error(`admin server dependency: ${name}`);
      if (
        workspace === 'packages/contracts' &&
        name.startsWith('@dhamani/') &&
        name !== '@dhamani/domain'
      )
        throw new Error(`contracts forbidden edge: ${name}`);
      if (workspace === 'packages/config' && name.startsWith('@dhamani/'))
        throw new Error(`config forbidden workspace edge: ${name}`);
      if (workspace === 'packages/db' && name.startsWith('@dhamani/') && name !== '@dhamani/config')
        throw new Error(`db forbidden workspace edge: ${name}`);
      if (
        workspace === 'packages/observability' &&
        name.startsWith('@dhamani/') &&
        name !== '@dhamani/config'
      )
        throw new Error(`observability forbidden workspace edge: ${name}`);
    }
    if (workspace === 'packages/domain') {
      const runtime = runtimeDependencyNames(manifest);
      if (runtime.length > 0) throw new Error(`domain runtime dependency: ${runtime.join(', ')}`);
      const unexpectedDev = Object.keys(manifest.devDependencies ?? {}).filter(
        (name) => name !== 'typescript',
      );
      if (unexpectedDev.length > 0)
        throw new Error(
          `domain development dependency outside tooling allowlist: ${unexpectedDev.join(', ')}`,
        );
    }
    const runtimeAllowlist = runtimeAllowlists.get(workspace);
    if (runtimeAllowlist) {
      const unexpectedRuntime = runtimeDependencyNames(manifest).filter(
        (name) => !runtimeAllowlist.has(name),
      );
      if (unexpectedRuntime.length > 0)
        throw new Error(
          `${workspace} runtime dependency outside frozen allowlist: ${unexpectedRuntime.join(', ')}`,
        );
    }
  }
  assertNoRuntimeCycles(manifests);

  const inventory = readJson<Inventory>('tooling/boundaries/production-source-inventory.json');
  for (const file of inventory.production) {
    const absolute = join(root, file);
    if (!existsSync(absolute)) throw new Error(`missing inventoried production source: ${file}`);
    const workspace = workspaceFor(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : file.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : file.endsWith('.js')
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
    );
    if (!file.startsWith('packages/config/src/') && readsProcessEnv(source))
      throw new Error(`process.env outside config: ${file}`);
    for (const specifier of importSpecifiers(source)) {
      if (specifier === '@dhamani/testkit' || specifier.startsWith('@dhamani/testkit/'))
        throw new Error(`production testkit import: ${file}`);
      const targetWorkspace = targetWorkspaceForSpecifier(file, specifier);
      if (targetWorkspace && appWorkspaces.has(targetWorkspace) && targetWorkspace !== workspace)
        throw new Error(`app-to-app or package-to-app import: ${file} -> ${specifier}`);
      if (targetWorkspace === 'packages/testkit')
        throw new Error(`production testkit import: ${file}`);
      if (workspace === 'apps/mobile' && targetWorkspace && serverWorkspaces.has(targetWorkspace))
        throw new Error(`mobile server import: ${file}`);
      if (
        targetWorkspace &&
        targetWorkspace !== workspace &&
        !sourceWorkspaceAllowlists.get(workspace)?.has(targetWorkspace)
      )
        throw new Error(`forbidden workspace source import: ${file} -> ${specifier}`);
      if (workspace === 'packages/domain' && !specifier.startsWith('.') && !targetWorkspace)
        throw new Error(`domain infrastructure import: ${file} -> ${specifier}`);
    }
  }
}

try {
  verify();
  pass('spec000_dependency_boundaries_enforced');
  pass('spec000_no_app_to_app_imports');
  pass('spec000_domain_is_pure_typescript');
  pass('spec000_process_env_access_is_config_only');
  pass('spec000_mobile_has_no_server_db_dependency');
  pass('spec000_production_testkit_absence');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
