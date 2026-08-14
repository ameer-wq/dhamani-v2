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
export function walk(directory: string, extensions: readonly string[]): string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((name) => {
    const path = join(absolute, name);
    if (['node_modules', 'dist', '.next', '.expo', 'generated'].includes(name)) return [];
    if (statSync(path).isDirectory()) return walk(relative(root, path), extensions);
    return extensions.includes(extname(path)) || name.endsWith('.d.ts')
      ? [relative(root, path).replaceAll('\\', '/')]
      : [];
  });
}
