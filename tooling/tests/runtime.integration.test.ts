import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { resolveRuntimeConfig } from '../../packages/config/src/index.ts';
import { createApi } from '../../apps/api/src/bootstrap.js';

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('SPEC-000 runtime integration', () => {
  it('spec000_logging_redaction_positive_probe', async () => {
    const sentinels = [
      'Bearer AUTH-SECRET-7f9',
      'COOKIE-SECRET-8a1',
      'BODY-SECRET-3c2',
      'CONFIG-SECRET-4d6',
    ];
    const output = new PassThrough();
    let logs = '';
    output.on('data', (chunk) => {
      logs += String(chunk);
    });
    const config = resolveRuntimeConfig({
      DHAMANI_RUNTIME_MODE: 'test',
      DATABASE_URL: 'postgresql://none:none@127.0.0.1:1/none',
      DHAMANI_PRIVATE_SENTINEL: sentinels[3],
      PORT: '3010',
    });
    const app = await createApi(config, output);
    apps.push(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    await fetch(`http://127.0.0.1:${address.port}/missing`, {
      method: 'POST',
      headers: {
        authorization: sentinels[0]!,
        cookie: sentinels[1]!,
        'content-type': 'application/json',
        'x-request-id': 'request-safe-123',
      },
      body: JSON.stringify({ value: sentinels[2] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const sentinel of sentinels) expect(logs).not.toContain(sentinel);
    for (const safe of ['request-safe-123', 'dhamani-api', 'status', 'path', 'level'])
      expect(logs).toContain(safe);
  });
});
