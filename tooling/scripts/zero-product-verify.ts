import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fail, pass, readJson, root, walk } from './lib.ts';

type Inventory = {
  extensions: string[];
  generatedExclusions: string[];
  buildOutputExclusions: string[];
  production: string[];
  developmentOnly: string[];
};

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
const expectedAllWorkspaces = [...productionRoots, 'packages/testkit'].sort();
const expectedGeneratedExclusions = ['packages/db/generated'];
const expectedExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'].sort();
const expectedBuildOutputExclusions = [
  'apps/api/dist',
  'apps/mobile/.expo',
  'apps/mobile/.spec000-export',
  'apps/admin/.next',
  'packages/domain/dist',
  'packages/contracts/dist',
  'packages/config/dist',
  'packages/db/dist',
  'packages/observability/dist',
].sort();

const productSurface =
  /(deal|agreement|revision|ledger|payment|payout|refund|dispute|kyc|otp|booking|subscription|digital\s*asset|financial\s*intent|auth|user)/i;

function normalizeSurface(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.\-/\\]+/g, ' ');
}

function copyFilePreservingPath(
  sourceRoot: string,
  targetRoot: string,
  relativePath: string,
): void {
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(sourceRoot, relativePath), target);
}

function runRequiredNegativeExtraFileFixture(inventory: Inventory): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dhamani-zero-product-'));
  try {
    copyFilePreservingPath(
      root,
      fixtureRoot,
      'tooling/boundaries/production-source-inventory.json',
    );
    for (const file of inventory.production) copyFilePreservingPath(root, fixtureRoot, file);
    for (const workspace of expectedAllWorkspaces)
      copyFilePreservingPath(root, fixtureRoot, `${workspace}/package.json`);
    copyFilePreservingPath(root, fixtureRoot, 'packages/db/prisma/schema.prisma');
    const unexpected = join(fixtureRoot, 'apps/api/src/innocent.ts');
    mkdirSync(dirname(unexpected), { recursive: true });
    writeFileSync(unexpected, 'export const innocentBootstrapMarker = true;\n');
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', fileURLToPath(import.meta.url), '--fixture-child'],
      { cwd: fixtureRoot, encoding: 'utf8' },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 1 || !output.includes('inventory mismatch'))
      throw new Error(
        `real extra-file fixture did not fail closed: status=${String(result.status)}`,
      );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function verify(): Inventory {
  const inventory = readJson<Inventory>('tooling/boundaries/production-source-inventory.json');
  if (JSON.stringify([...inventory.extensions].sort()) !== JSON.stringify(expectedExtensions))
    throw new Error('production source extensions differ from the frozen six-extension set');
  const actualWorkspaces = ['apps', 'packages']
    .flatMap((parent) =>
      readdirSync(join(root, parent))
        .filter((name) => statSync(join(root, parent, name)).isDirectory())
        .filter((name) => {
          const manifest = join(root, parent, name, 'package.json');
          return statSync(manifest, { throwIfNoEntry: false })?.isFile() === true;
        })
        .map((name) => `${parent}/${name}`),
    )
    .sort();
  if (JSON.stringify(actualWorkspaces) !== JSON.stringify(expectedAllWorkspaces))
    throw new Error(
      `workspace topology differs actual=${JSON.stringify(actualWorkspaces)} expected=${JSON.stringify(expectedAllWorkspaces)}`,
    );
  if (
    JSON.stringify([...inventory.generatedExclusions].sort()) !==
    JSON.stringify(expectedGeneratedExclusions)
  )
    throw new Error('generated source exclusions differ from the frozen path');
  if (
    JSON.stringify([...inventory.buildOutputExclusions].sort()) !==
    JSON.stringify(expectedBuildOutputExclusions)
  )
    throw new Error('build output exclusions differ from declared workspace outputs');
  const exclusions = [
    ...inventory.generatedExclusions,
    ...inventory.buildOutputExclusions,
    ...productionRoots.map((workspace) => `${workspace}/node_modules`),
  ];
  for (const exclusion of exclusions) {
    if (!exclusion.includes('/') || exclusion.startsWith('/') || exclusion.includes('..'))
      throw new Error(`invalid non-anchored source exclusion: ${exclusion}`);
  }
  const actual = productionRoots
    .flatMap((workspace) =>
      walk(workspace, inventory.extensions, { rootDirectory: root, excludedPaths: exclusions }),
    )
    .sort();
  const frozen = [...inventory.production].sort();
  if (JSON.stringify(actual) !== JSON.stringify(frozen))
    throw new Error(
      `inventory mismatch actual=${JSON.stringify(actual)} frozen=${JSON.stringify(frozen)}`,
    );
  for (const file of frozen) {
    const text = readFileSync(join(root, file), 'utf8');
    if (productSurface.test(normalizeSurface(file)) || productSurface.test(normalizeSurface(text)))
      throw new Error(`product surface in ${file}`);
  }
  const schema = readFileSync(join(root, 'packages/db/prisma/schema.prisma'), 'utf8');
  if (/^\s*model\s+/m.test(schema)) throw new Error('Prisma model found');
  const controller = readFileSync(join(root, 'apps/api/src/app.controller.ts'), 'utf8');
  if (
    !controller.includes("@Get('live')") ||
    !controller.includes("@Get('ready')") ||
    controller.match(/@Get\(/g)?.length !== 2
  )
    throw new Error('API route surface differs');
  return inventory;
}

try {
  const inventory = verify();
  const fixtureChild = process.argv.includes('--fixture-child');
  if (fixtureChild) process.exit(0);
  runRequiredNegativeExtraFileFixture(inventory);
  pass('spec000_no_product_logic_surface', {
    files: [...inventory.production].sort(),
    negativeExtraFileFixture: 'subprocess-rejected',
  });
  pass('spec000_api_has_no_product_routes');
  pass('spec000_no_auth_payment_provider_or_mock_surface');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
