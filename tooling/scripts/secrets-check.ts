import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fail, pass, root, walk } from './lib.ts';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{30,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
];
for (const file of files) {
  const text = readFileSync(`${root}/${file}`, 'utf8');
  if (secretPatterns.some((p) => p.test(text))) fail(`secret pattern in ${file}`);
}
for (const file of walk('apps', ['.ts', '.tsx', '.js', '.jsx'])) {
  const text = readFileSync(`${root}/${file}`, 'utf8');
  if (/(?:EXPO_PUBLIC|NEXT_PUBLIC)_[A-Z0-9_]*(?:SECRET|TOKEN|PRIVATE|DATABASE)/.test(text))
    fail(`private public env surface ${file}`);
}
pass('spec000_secret_scan_is_required_gate');
pass('spec000_no_private_secret_public_env_surface');
