import { fail, pass, root } from './lib.ts';
import { verifyWorkspaceTypeScriptFlags } from './tsconfig-policy.ts';

const fixtureIndex = process.argv.indexOf('--fixture-workspace');
const workspaces = fixtureIndex >= 0 ? [process.argv[fixtureIndex + 1] ?? ''] : undefined;
try {
  const verified = verifyWorkspaceTypeScriptFlags(root, workspaces);
  pass('spec000_no_workspace_weakens_required_ts_flags', { workspaces: verified });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
