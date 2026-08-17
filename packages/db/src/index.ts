import { Client } from 'pg';
import type { RuntimeConfig } from '@dhamani/config';

export async function databaseIsReachable(config: RuntimeConfig): Promise<boolean> {
  const client = new Client({
    connectionString: config.database.url,
    connectionTimeoutMillis: 1000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
