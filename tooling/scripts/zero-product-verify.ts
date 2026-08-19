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
  spec001Prefixes: string[];
  spec001Barrels: string[];
  spec001Models: string[];
  spec001Commands: string[];
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

/**
 * SPEC-001 is the first product kernel, so the bootstrap-era "zero product surface" assertion is
 * now scoped rather than removed. Two prohibitions run side by side:
 *
 *   - every production file that is NOT declared SPEC-001 kernel source keeps the original
 *     SPEC-000 prohibition verbatim, so the bootstrap surface is still frozen;
 *   - declared SPEC-001 files may use Deal/Agreement kernel vocabulary, but are still forbidden
 *     from carrying any financial, vertical-runtime, provider-integration or production-identity
 *     execution surface (Frozen SPEC §1 SHALL NOT, §33.11).
 *
 * The structural checks below — exact Prisma model set, exact command registry, HTTP route
 * enumeration and forbidden-column scan — are the real teeth, because they enumerate applied
 * surface instead of matching prose.
 */
const bootstrapProductSurface =
  /(deal|agreement|revision|ledger|payment|payout|refund|dispute|kyc|otp|booking|subscription|digital\s*asset|financial\s*intent|auth|user)/i;

const outOfScopeExecutionSurface =
  /(ledger|payout|refund|wallet|escrow|financial\s*intent|funding\s*deadline|psp|outbox|webhook|reconciliation|dispute|kyc|otp|payment|settlement|money\s*movement)/i;

const expectedSpec001Prefixes = ['apps/api/src/spec001/', 'packages/domain/src/spec001/'].sort();

/**
 * Barrel files that live outside the kernel directories but exist to re-export it. They are
 * declared one by one — never by prefix — so the SPEC-001 allowance cannot quietly spread to
 * unrelated bootstrap files.
 */
const expectedSpec001Barrels = ['packages/domain/src/index.ts'].sort();

/** The six tables the Frozen SPEC mandates (§24). A seventh model fails this gate. */
const expectedSpec001Models = [
  'AgreementRevision',
  'ApplicationIdempotencyRecord',
  'Deal',
  'DealAgreementAuditEvent',
  'DealPartySlot',
  'RevisionResponse',
].sort();

/** The eight application commands (§21). No ninth command may appear without a reviewed spec. */
const expectedSpec001Commands = [
  'AcceptCurrentRevision',
  'BindCounterpartyPrincipal',
  'CreateFormalDeal',
  'ExpireInvitationIfDue',
  'ProposeChanges',
  'RejectCurrentRevision',
  'WithdrawInvitation',
  'WithdrawNegotiation',
].sort();

/** Columns that would betray a financial execution surface leaking into the kernel schema. */
const forbiddenSchemaColumns =
  /(fundingDeadline|amount|currency|balance|ledger|payout|refund|fee|wallet|escrow|price)/i;

/** HTTP route decorators. SPEC-001 introduces no participant-facing endpoint at all (§28). */
const httpRouteDecorator = /@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(/;

function normalizeSurface(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.\-/\\]+/g, ' ');
}

/**
 * Removes comments so the out-of-scope scan judges code surface rather than prose. A comment that
 * mentions a later funding spec is documentation; an identifier named `payoutAmount` is surface.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function isSpec001Source(file: string, inventory: Inventory): boolean {
  return (
    inventory.spec001Prefixes.some((prefix) => file.startsWith(prefix)) ||
    inventory.spec001Barrels.includes(file)
  );
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

  // The SPEC-001 allowance itself is frozen in this script, so the inventory file cannot widen
  // which paths, models or commands are permitted.
  if (
    JSON.stringify([...inventory.spec001Prefixes].sort()) !==
    JSON.stringify(expectedSpec001Prefixes)
  )
    throw new Error('spec001 source prefixes differ from the frozen kernel paths');
  if (
    JSON.stringify([...inventory.spec001Barrels].sort()) !== JSON.stringify(expectedSpec001Barrels)
  )
    throw new Error('spec001 barrel allowlist differs from the frozen file set');
  if (JSON.stringify([...inventory.spec001Models].sort()) !== JSON.stringify(expectedSpec001Models))
    throw new Error('spec001 model set differs from the six frozen tables');
  if (
    JSON.stringify([...inventory.spec001Commands].sort()) !==
    JSON.stringify(expectedSpec001Commands)
  )
    throw new Error('spec001 command registry differs from the eight frozen commands');

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
    if (isSpec001Source(file, inventory)) {
      // Declared kernel source: Deal/Agreement vocabulary is expected, out-of-scope execution
      // surface is not.
      const code = normalizeSurface(stripComments(text));
      if (
        outOfScopeExecutionSurface.test(code) ||
        outOfScopeExecutionSurface.test(normalizeSurface(file))
      )
        throw new Error(`out-of-scope execution surface in ${file}`);
    } else if (
      bootstrapProductSurface.test(normalizeSurface(file)) ||
      bootstrapProductSurface.test(normalizeSurface(text))
    ) {
      throw new Error(`product surface in ${file}`);
    }
    // No production file outside the health controller may declare an HTTP route (§28).
    if (file !== 'apps/api/src/app.controller.ts' && httpRouteDecorator.test(text))
      throw new Error(`participant-facing HTTP route surface in ${file}`);
  }

  const schema = readFileSync(join(root, 'packages/db/prisma/schema.prisma'), 'utf8');
  const declaredModels = [...schema.matchAll(/^\s*model\s+(\w+)\s*\{/gm)]
    .map((match) => match[1]!)
    .sort();
  if (JSON.stringify(declaredModels) !== JSON.stringify(expectedSpec001Models))
    throw new Error(
      `prisma model set differs actual=${JSON.stringify(declaredModels)} expected=${JSON.stringify(expectedSpec001Models)}`,
    );
  for (const line of schema.split('\n')) {
    const fieldName = /^\s{2}(\w+)\s+\S/.exec(line)?.[1];
    if (fieldName && forbiddenSchemaColumns.test(fieldName))
      throw new Error(`financial execution column in prisma schema: ${fieldName}`);
  }

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
  pass('spec001_zero_financial_execution_surface', {
    models: expectedSpec001Models,
    commands: expectedSpec001Commands,
    forbiddenColumnScan: 'clean',
  });
  pass('spec001_has_no_untrusted_principal_http_authority', {
    routes: ["@Get('live')", "@Get('ready')"],
    otherRouteDeclaringFiles: 0,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
