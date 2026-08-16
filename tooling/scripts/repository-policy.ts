import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

const dbPush = /\b(?:prisma\s+)?db\s+push\b/i;

/**
 * Every workspace manifest declared by pnpm-workspace.yaml, plus the root manifest. Unsupported
 * glob shapes throw rather than silently narrowing the scan, so a future workspace layout cannot
 * quietly drop packages out of the INV-000-013 surface.
 */
function workspaceManifestPaths(repositoryRoot: string): string[] {
  const manifests = [join(repositoryRoot, 'package.json')];
  const workspaceFile = join(repositoryRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceFile)) return manifests;
  const parsed = parse(readFileSync(workspaceFile, 'utf8')) as { packages?: unknown };
  if (!Array.isArray(parsed.packages) || parsed.packages.length === 0)
    throw new Error('pnpm-workspace.yaml declares no package patterns');
  for (const pattern of parsed.packages) {
    if (typeof pattern !== 'string')
      throw new Error(`unsupported workspace pattern: ${JSON.stringify(pattern)}`);
    // Reject every glob shape this expander does not implement before attempting to expand, so a
    // pattern such as "**/*" can never be silently narrowed to a single directory level.
    const single = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    if (/[*?!{}[\]]/.test(single))
      throw new Error(`unsupported workspace pattern for db push policy: ${pattern}`);
    if (pattern.endsWith('/*')) {
      const parent = join(repositoryRoot, single);
      if (!existsSync(parent))
        throw new Error(`workspace pattern resolves to no directory: ${pattern}`);
      for (const name of readdirSync(parent).sort()) {
        const directory = join(parent, name);
        const candidate = join(directory, 'package.json');
        if (statSync(directory).isDirectory() && existsSync(candidate)) manifests.push(candidate);
      }
      continue;
    }
    const candidate = join(repositoryRoot, pattern, 'package.json');
    if (!existsSync(candidate))
      throw new Error(`workspace pattern resolves to no manifest: ${pattern}`);
    manifests.push(candidate);
  }
  return manifests;
}

function workflowFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return workflowFiles(path);
    return /\.ya?ml$/i.test(name) ? [path] : [];
  });
}

function runScalars(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(runScalars);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === 'run' && typeof child === 'string' ? [child] : []),
    ...runScalars(child),
  ]);
}

/** Returns every scanned file, so callers can assert the scan actually covered each workspace. */
export function verifyNoDbPush(repositoryRoot: string): string[] {
  const scanned: string[] = [];
  const asRelative = (path: string): string =>
    relative(repositoryRoot, path).replaceAll('\\', '/') || 'package.json';
  for (const manifestPath of workspaceManifestPaths(repositoryRoot)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const location = asRelative(manifestPath);
    scanned.push(location);
    for (const [name, command] of Object.entries(manifest.scripts ?? {}))
      if (dbPush.test(command)) throw new Error(`db push forbidden in ${location} script ${name}`);
  }
  for (const workflow of workflowFiles(join(repositoryRoot, '.github/workflows'))) {
    const location = asRelative(workflow);
    scanned.push(location);
    const parsed = parse(readFileSync(workflow, 'utf8')) as unknown;
    for (const command of runScalars(parsed))
      if (dbPush.test(command)) throw new Error(`db push forbidden in workflow ${location}`);
  }
  return scanned;
}

export const documentedVerificationCommands = [
  'pnpm install --frozen-lockfile',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm test',
  'pnpm build',
  'pnpm boundaries:check',
  'pnpm secrets:check',
  'pnpm db:validate',
  'pnpm db:migrate:deploy',
  'pnpm mobile:typecheck',
  'pnpm mobile:doctor',
  'pnpm mobile:export:ci',
  'pnpm spec000:evidence:verify',
  'pnpm spec000:ci-definition:verify',
  'pnpm toolchain:verify',
  'pnpm ci:verify',
  'pnpm spec000:zero-product-logic:verify',
  'pnpm spec000:build-artifacts:verify',
  'pnpm spec000:github-protection:verify',
] as const;

export function verifyAgentsDocumentsCommands(repositoryRoot: string): void {
  const agents = readFileSync(join(repositoryRoot, 'AGENTS.md'), 'utf8');
  for (const command of documentedVerificationCommands)
    if (!agents.includes(`\`${command}\``)) throw new Error(`AGENTS.md omits ${command}`);
}
