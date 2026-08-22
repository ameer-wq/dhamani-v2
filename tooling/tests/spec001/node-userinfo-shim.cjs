/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Test-process bootstrap only: the Codex Windows sandbox denies uv_os_get_passwd, which TSX uses
// solely to name its temporary IPC directory. Preserve the real OS result everywhere it works and
// substitute a deterministic temporary-directory username only for that sandbox failure.
const os = require('node:os');

try {
  os.userInfo();
} catch {
  os.userInfo = () => ({
    username: 'codex',
    uid: -1,
    gid: -1,
    shell: null,
    homedir: process.cwd(),
  });
}
