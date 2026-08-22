import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tooling/tests/**/*.test.ts'],
    // Provisions and migrates a dedicated database for the SPEC-001 real-PostgreSQL evidence
    // suites, so SPEC-000's migration probe still observes a genuinely clean DATABASE_URL.
    globalSetup: ['tooling/tests/spec001/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
