import { execFileSync, spawnSync } from 'node:child_process';
import type {
  ExecFileSyncOptionsWithStringEncoding,
  SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';

export function packageManagerInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { executable: string; args: string[] } {
  const npmExecPath = environment.npm_execpath;
  if (!npmExecPath)
    throw new Error('npm_execpath is required for cross-platform package-manager execution');
  return { executable: process.execPath, args: [npmExecPath, ...args] };
}

export function execPackageManagerSync(
  args: readonly string[],
  options: Omit<ExecFileSyncOptionsWithStringEncoding, 'encoding'> & {
    encoding?: BufferEncoding;
  } = {},
): string {
  const invocation = packageManagerInvocation(args, options.env ?? process.env);
  return execFileSync(invocation.executable, invocation.args, {
    maxBuffer: 50 * 1024 * 1024,
    ...options,
    encoding: options.encoding ?? 'utf8',
  });
}

export function spawnPackageManagerSync(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' },
) {
  const invocation = packageManagerInvocation(args, options.env ?? process.env);
  return spawnSync(invocation.executable, invocation.args, {
    maxBuffer: 50 * 1024 * 1024,
    ...options,
    encoding: options.encoding ?? 'utf8',
  });
}
