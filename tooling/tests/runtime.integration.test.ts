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
      'APIKEY-SECRET-5e7',
      'Basic PROXY-SECRET-6f8',
      'AWS-SESSION-SECRET-7a9',
      'UNKNOWN-HEADER-SECRET-8b0',
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
        'x-api-key': sentinels[4]!,
        'proxy-authorization': sentinels[5]!,
        'x-amz-security-token': sentinels[6]!,
        'x-unknown-private-header': sentinels[7]!,
      },
      body: JSON.stringify({ value: sentinels[2] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const sentinel of sentinels) expect(logs).not.toContain(sentinel);
    const records = logs
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const requestLog = records.find((record) => record.msg === 'request completed');
    expect(requestLog).toMatchObject({
      service: 'dhamani-api',
      runtimeMode: 'test',
      requestId: 'request-safe-123',
      method: 'POST',
      path: '/missing',
      status: 404,
      privateSentinel: '[REDACTED]',
      msg: 'request completed',
    });
    expect(typeof requestLog?.time).toBe('string');
    expect(typeof requestLog?.level).toBe('number');
  });
});
