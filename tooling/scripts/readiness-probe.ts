import { execFileSync } from 'node:child_process';
import { resolveRuntimeConfig } from '../../packages/config/src/index.ts';
import { createApi } from '../../apps/api/src/bootstrap.ts';
import { fail, pass } from './lib.ts';

const config = resolveRuntimeConfig();
const app = await createApi(config);
await app.listen(0);
const address = app.getHttpServer().address() as { port: number };
const ready = () => fetch(`http://127.0.0.1:${address.port}/health/ready`);
try {
  if ((await ready()).status !== 200) fail('readiness not successful with reachable PostgreSQL');
  execFileSync('docker', ['compose', 'stop', 'postgres'], { stdio: 'inherit' });
  if ((await ready()).status !== 503)
    fail('readiness did not become 503 with PostgreSQL unavailable');
  execFileSync('docker', ['compose', 'start', 'postgres'], { stdio: 'inherit' });
  let restored = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if ((await ready()).status === 200) {
      restored = true;
      break;
    }
  }
  if (!restored) fail('readiness did not recover after PostgreSQL restore');
  pass('spec000_readiness_reflects_real_database_dependency', {
    reachable: 200,
    unavailable: 503,
    restored: 200,
    runtimeMode: config.runtimeMode,
  });
} finally {
  await app.close();
}
