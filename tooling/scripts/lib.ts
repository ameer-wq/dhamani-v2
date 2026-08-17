import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export const root = process.cwd();
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}
export function fail(message: string): never {
  console.error(JSON.stringify({ status: 'fail', message }));
  process.exit(1);
}
export function pass(check: string, details: unknown = {}): void {
  console.log(JSON.stringify({ check, status: 'pass', details }));
}
function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  const normalized = normalize(path);
  return exclusions.some((entry) => {
    const exclusion = normalize(entry);
    return normalized === exclusion || normalized.startsWith(`${exclusion}/`);
  });
}

export function walk(
  directory: string,
  extensions: readonly string[],
  options: { rootDirectory?: string; excludedPaths?: readonly string[] } = {},
): string[] {
  const rootDirectory = options.rootDirectory ?? root;
  const exclusions = options.excludedPaths ?? [];
  const absolute = join(rootDirectory, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .sort()
    .flatMap((name) => {
      const path = join(absolute, name);
      const relativePath = normalize(relative(rootDirectory, path));
      if (isExcluded(relativePath, exclusions)) return [];
      if (statSync(path).isDirectory())
        return walk(relativePath, extensions, { rootDirectory, excludedPaths: exclusions });
      return extensions.includes(extname(path)) || name.endsWith('.d.ts') ? [relativePath] : [];
    });
}
