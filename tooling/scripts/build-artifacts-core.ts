import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const productionBuildRoots = [
  'apps/api/dist',
  'apps/admin/.next',
  'apps/mobile/.spec000-export',
] as const;

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export function verifyProductionBuildTestkitAbsence(
  repositoryRoot: string,
  outputRoots: readonly string[] = productionBuildRoots,
): { filesScanned: number } {
  let filesScanned = 0;
  for (const outputRoot of outputRoots) {
    const absolute = join(repositoryRoot, outputRoot);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory())
      throw new Error(`required production build output missing: ${outputRoot}`);
    const files = filesUnder(absolute);
    if (files.length === 0)
      throw new Error(`required production build output empty: ${outputRoot}`);
    for (const file of files) {
      filesScanned += 1;
      const bytes = readFileSync(file);
      if (
        bytes.includes(Buffer.from('@dhamani/testkit')) ||
        bytes.includes(Buffer.from('packages/testkit')) ||
        bytes.includes(Buffer.from('packages\\testkit'))
      )
        throw new Error(`production build contains @dhamani/testkit: ${file}`);
    }
  }
  return { filesScanned };
}
