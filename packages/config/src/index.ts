import { z } from 'zod';

const developmentDatabaseUrl =
  'postgresql://dhamani_dev:dhamani_dev_only@localhost:5432/dhamani_dev';
const developmentPrivateSentinel = 'development-only-private-sentinel';

const schema = z.object({
  DHAMANI_RUNTIME_MODE: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.string().url(),
  DHAMANI_PRIVATE_SENTINEL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type RuntimeConfig = Readonly<{
  runtimeMode: 'development' | 'test' | 'production';
  database: Readonly<{ url: string }>;
  privateSentinel: string;
  port: number;
}>;

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object') deepFreeze(nested as object);
  }
  return Object.freeze(value);
}

export function resolveRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) throw new Error('CONFIG_INVALID');
  const value = parsed.data;
  if (value.DHAMANI_RUNTIME_MODE === 'production') {
    const host = new URL(value.DATABASE_URL).hostname;
    if (
      value.DATABASE_URL === developmentDatabaseUrl ||
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) ||
      value.DATABASE_URL.includes('dhamani_dev') ||
      value.DHAMANI_PRIVATE_SENTINEL === developmentPrivateSentinel
    ) {
      throw new Error('CONFIG_PRODUCTION_DEVELOPMENT_VALUE_REJECTED');
    }
  }
  return deepFreeze({
    runtimeMode: value.DHAMANI_RUNTIME_MODE,
    database: { url: value.DATABASE_URL },
    privateSentinel: value.DHAMANI_PRIVATE_SENTINEL,
    port: value.PORT,
  });
}
