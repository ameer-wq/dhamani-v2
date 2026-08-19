import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  combinedOutput,
  createProductionFixture,
  readRelative,
  removeFixture,
  runToolingScript,
  writeRelative,
} from './fixture-helpers.ts';

const productionRoots = [
  'apps/api',
  'apps/mobile',
  'apps/admin',
  'packages/domain',
  'packages/contracts',
  'packages/config',
  'packages/db',
  'packages/observability',
] as const;
const compiledSourceRoots = new Map<string, string>([
  ['apps/api', 'apps/api/src'],
  ['apps/mobile', 'apps/mobile'],
  ['apps/admin', 'apps/admin/app'],
  ['packages/domain', 'packages/domain/src'],
  ['packages/contracts', 'packages/contracts/src'],
  ['packages/config', 'packages/config/src'],
  ['packages/db', 'packages/db/src'],
  ['packages/observability', 'packages/observability/src'],
]);

describe('zero-product verifier adversarial regressions', () => {
  it('accepts the clean frozen inventory and executes the real extra-file self-test', () => {
    const result = runToolingScript('zero-product-verify.ts');
    expect(combinedOutput(result)).toContain('subprocess-rejected');
    expect(result.status).toBe(0);
  });

  it('rejects an actual innocuously named production file outside the inventory', () => {
    const fixture = createProductionFixture();
    try {
      writeRelative(fixture, 'apps/api/src/innocent.ts', 'export const innocent = true;\n');
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('inventory mismatch');
    } finally {
      removeFixture(fixture);
    }
  });

  it.each(
    productionRoots.flatMap((root) =>
      ['generated', 'dist', '.next'].map((directory) => [root, directory] as const),
    ),
  )('rejects name-based escape %s/**/%s/x.ts', (workspace, directory) => {
    const fixture = createProductionFixture();
    try {
      writeRelative(
        fixture,
        `${compiledSourceRoots.get(workspace)!}/escape/${directory}/x.ts`,
        'export const hiddenBootstrapCode = true;\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('inventory mismatch');
    } finally {
      removeFixture(fixture);
    }
  });

  it('excludes only the path-anchored generated directory declared by the inventory', () => {
    const fixture = createProductionFixture();
    try {
      writeRelative(
        fixture,
        'packages/db/generated/client.ts',
        'export const generatedClientMarker = true;\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(combinedOutput(result)).not.toContain('inventory mismatch');
      expect(result.status).toBe(0);
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects product symbols even when the former magic escape phrase is present', () => {
    const fixture = createProductionFixture();
    try {
      writeRelative(
        fixture,
        'packages/contracts/src/index.ts',
        '// no API DTOs\nexport class DealLedger { settlePayment(): void {} }\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('product surface');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects lowercase compound product identifiers', () => {
    const fixture = createProductionFixture();
    try {
      writeRelative(
        fixture,
        'packages/contracts/src/index.ts',
        'export const paymentledger = true;\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('product surface');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects removal of a frozen production source extension', () => {
    const fixture = createProductionFixture();
    try {
      const path = join(fixture, 'tooling/boundaries/production-source-inventory.json');
      const inventory = JSON.parse(readFileSync(path, 'utf8')) as { extensions: string[] };
      inventory.extensions = inventory.extensions.filter((extension) => extension !== '.js');
      writeFileSync(path, JSON.stringify(inventory));
      writeRelative(
        fixture,
        'apps/api/src/escape/hidden.js',
        'export const paymentledger = true;\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('six-extension set');
    } finally {
      removeFixture(fixture);
    }
  });
});

/**
 * SPEC-001 made the bootstrap "zero product surface" gate successor-aware. These regressions
 * prove the narrowed gate is still fail-closed: the SPEC-000 prohibition survives verbatim for
 * every non-kernel file, and the kernel allowance cannot be widened or abused.
 */
describe('successor-aware zero-product verifier remains fail-closed', () => {
  function mutateInventory(fixture: string, mutate: (inventory: Record<string, unknown>) => void) {
    const path = join(fixture, 'tooling/boundaries/production-source-inventory.json');
    const inventory = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    mutate(inventory);
    writeFileSync(path, JSON.stringify(inventory));
  }

  it('still rejects kernel vocabulary in a non-SPEC-001 bootstrap file', () => {
    const fixture = createProductionFixture();
    try {
      // packages/contracts is not declared SPEC-001 source, so the original SPEC-000 prohibition
      // must still apply to it in full.
      writeRelative(
        fixture,
        'packages/contracts/src/index.ts',
        'export type DealAgreementRevision = { id: string };\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('product surface');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects out-of-scope financial execution surface inside a SPEC-001 kernel file', () => {
    const fixture = createProductionFixture();
    try {
      writeRelative(
        fixture,
        'packages/domain/src/spec001/state.ts',
        'export const payoutLedgerEntry = { refund: true };\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('out-of-scope execution surface');
    } finally {
      removeFixture(fixture);
    }
  });

  it('does not let a comment launder an out-of-scope identifier back in', () => {
    const fixture = createProductionFixture();
    try {
      // Prose about a later spec is documentation and must stay allowed...
      writeRelative(
        fixture,
        'packages/domain/src/spec001/state.ts',
        '// A later funding spec owns payout and refund behavior.\nexport const marker = true;\n',
      );
      expect(runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']).status).toBe(
        0,
      );
      // ...but the same words as real code surface must not be.
      writeRelative(
        fixture,
        'packages/domain/src/spec001/state.ts',
        'export const refundAmount = 1;\n',
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('out-of-scope execution surface');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects a seventh Prisma model beyond the six frozen tables', () => {
    const fixture = createProductionFixture();
    try {
      const path = join(fixture, 'packages/db/prisma/schema.prisma');
      writeFileSync(
        path,
        `${readFileSync(path, 'utf8')}\nmodel WalletBalance {\n  id String @id @db.Uuid\n}\n`,
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('prisma model set differs');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects a financial execution column on a frozen table', () => {
    const fixture = createProductionFixture();
    try {
      const path = join(fixture, 'packages/db/prisma/schema.prisma');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '  version               Int',
          '  version               Int\n  fundingDeadline       DateTime?',
        ),
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('financial execution column');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects a participant-facing HTTP route declared outside the health controller', () => {
    const fixture = createProductionFixture();
    try {
      writeRelative(
        fixture,
        'apps/api/src/spec001/kernel.ts',
        "import { Controller, Get } from '@nestjs/common';\n" +
          "@Controller('deals')\nexport class Leak {\n  @Get(':id')\n  read(): null { return null; }\n}\n",
      );
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('participant-facing HTTP route surface');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects widening the SPEC-001 kernel path allowlist from the inventory file', () => {
    const fixture = createProductionFixture();
    try {
      mutateInventory(fixture, (inventory) => {
        (inventory.spec001Prefixes as string[]).push('packages/contracts/src/');
      });
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('spec001 source prefixes differ');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects widening the SPEC-001 barrel allowlist from the inventory file', () => {
    const fixture = createProductionFixture();
    try {
      mutateInventory(fixture, (inventory) => {
        (inventory.spec001Barrels as string[]).push('packages/contracts/src/index.ts');
      });
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('spec001 barrel allowlist differs');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects adding a ninth command to the declared registry', () => {
    const fixture = createProductionFixture();
    try {
      mutateInventory(fixture, (inventory) => {
        (inventory.spec001Commands as string[]).push('ReleaseFundsToSeller');
      });
      const result = runToolingScript('zero-product-verify.ts', fixture, ['--fixture-child']);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('spec001 command registry differs');
    } finally {
      removeFixture(fixture);
    }
  });
});

describe('dependency-boundary verifier adversarial regressions', () => {
  it('accepts the clean production graph', () => {
    const fixture = createProductionFixture();
    try {
      expect(runToolingScript('boundaries-check.ts', fixture).status).toBe(0);
    } finally {
      removeFixture(fixture);
    }
  });

  const cases: Array<{
    name: string;
    message: string;
    mutate(fixture: string): void;
  }> = [
    {
      name: 'app-to-app manifest dependency',
      message: 'app imports app',
      mutate(fixture) {
        const path = join(fixture, 'apps/api/package.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
          dependencies: Record<string, string>;
        };
        manifest.dependencies['@dhamani/admin'] = 'workspace:*';
        writeFileSync(path, JSON.stringify(manifest));
      },
    },
    {
      name: 'app-to-app source import',
      message: 'app-to-app or package-to-app import',
      mutate(fixture) {
        writeRelative(
          fixture,
          'apps/api/src/main.ts',
          `${readRelative(fixture, 'apps/api/src/main.ts')}\nimport '@dhamani/admin/app/page.js';\n`,
        );
      },
    },
    {
      name: 'domain framework runtime dependencies',
      message: 'domain runtime dependency',
      mutate(fixture) {
        const path = join(fixture, 'packages/domain/package.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        manifest.dependencies = {
          '@nestjs/common': '11.2.1',
          '@prisma/client': '7.9.1',
          pino: '10.3.1',
          pg: '8.23.0',
        };
        writeFileSync(path, JSON.stringify(manifest));
      },
    },
    {
      name: 'domain infrastructure source imports',
      message: 'domain infrastructure import',
      mutate(fixture) {
        writeRelative(
          fixture,
          'packages/domain/src/index.ts',
          "import '@nestjs/common';\nimport 'node:fs';\nexport const marker = true;\n",
        );
      },
    },
    {
      name: 'admin process.env read',
      message: 'process.env outside config',
      mutate(fixture) {
        writeRelative(
          fixture,
          'apps/admin/app/page.tsx',
          'const leaked = process.env.DATABASE_URL;\nexport default function Page() { return <main>{leaked}</main>; }\n',
        );
      },
    },
    {
      name: 'mobile relative database import',
      message: 'mobile server import',
      mutate(fixture) {
        writeRelative(
          fixture,
          'apps/mobile/App.tsx',
          "import '../../packages/db/src/index.ts';\nexport default function App() { return null; }\n",
        );
      },
    },
    {
      name: 'domain relative infrastructure import',
      message: 'forbidden workspace source import',
      mutate(fixture) {
        writeRelative(
          fixture,
          'packages/domain/src/index.ts',
          "import '../../db/src/index.ts';\nexport const marker = true;\n",
        );
      },
    },
    {
      name: 'production relative testkit import',
      message: 'production testkit import',
      mutate(fixture) {
        writeRelative(
          fixture,
          'apps/api/src/main.ts',
          "import '../../../packages/testkit/src/index.ts';\nexport const marker = true;\n",
        );
      },
    },
  ];

  it.each(cases)('rejects $name', ({ mutate, message }) => {
    const fixture = createProductionFixture();
    try {
      mutate(fixture);
      const result = runToolingScript('boundaries-check.ts', fixture);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain(message);
    } finally {
      removeFixture(fixture);
    }
  });
});

describe('production-build testkit absence verifier', () => {
  function buildFixture(): string {
    const fixture = createProductionFixture();
    for (const output of ['apps/api/dist', 'apps/admin/.next', 'apps/mobile/.spec000-export']) {
      mkdirSync(join(fixture, output), { recursive: true });
      writeRelative(fixture, `${output}/safe.js`, 'export const safe = true;\n');
    }
    return fixture;
  }

  it('accepts present clean synthetic production outputs', () => {
    const fixture = buildFixture();
    try {
      expect(runToolingScript('build-artifacts-verify.ts', fixture).status).toBe(0);
    } finally {
      removeFixture(fixture);
    }
  });

  it.each(['apps/api/dist', 'apps/admin/.next', 'apps/mobile/.spec000-export'])(
    'rejects @dhamani/testkit in %s',
    (output) => {
      const fixture = buildFixture();
      try {
        writeRelative(fixture, `${output}/unsafe.js`, "import '@dhamani/testkit';\n");
        const result = runToolingScript('build-artifacts-verify.ts', fixture);
        expect(result.status).toBe(1);
        expect(combinedOutput(result)).toContain('production build contains @dhamani/testkit');
      } finally {
        removeFixture(fixture);
      }
    },
  );

  it('rejects a missing production output root', () => {
    const fixture = createProductionFixture();
    try {
      const result = runToolingScript('build-artifacts-verify.ts', fixture);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('required production build output missing');
    } finally {
      removeFixture(fixture);
    }
  });

  it('rejects emitted relative testkit source traces', () => {
    const fixture = buildFixture();
    try {
      writeRelative(fixture, 'apps/api/dist/unsafe.js.map', '{"source":"packages/testkit/src"}');
      const result = runToolingScript('build-artifacts-verify.ts', fixture);
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('production build contains @dhamani/testkit');
    } finally {
      removeFixture(fixture);
    }
  });
});
