import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fail, pass, root } from './lib.ts';

// git ls-files reports the index, which still lists tracked files that have been deleted in the
// working tree. Those have no working-tree content to scan, so they are skipped rather than
// crashing the scanner with ENOENT. No allowlist or pattern bypass is introduced.
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => existsSync(`${root}/${file}`));
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{30,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
];
for (const file of files) {
  const text = readFileSync(`${root}/${file}`, 'utf8');
  if (secretPatterns.some((p) => p.test(text))) fail(`secret pattern in ${file}`);
}
for (const file of files.filter(
  (candidate) =>
    candidate.startsWith('apps/') && ['.ts', '.tsx', '.js', '.jsx'].includes(extname(candidate)),
)) {
  const text = readFileSync(`${root}/${file}`, 'utf8');
  if (/(?:EXPO_PUBLIC|NEXT_PUBLIC)_[A-Z0-9_]*(?:SECRET|TOKEN|PRIVATE|DATABASE)/.test(text))
    fail(`private public env surface ${file}`);
}
pass('spec000_secret_scan_is_required_gate');
pass('spec000_no_private_secret_public_env_surface');
