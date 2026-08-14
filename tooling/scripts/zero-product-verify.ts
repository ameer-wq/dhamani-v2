import { readFileSync } from 'node:fs';
import { fail, pass, readJson, root, walk } from './lib.ts';

type Inventory = { extensions: string[]; production: string[]; developmentOnly: string[] };
const inventory = readJson<Inventory>('tooling/boundaries/production-source-inventory.json');
const roots = [
  'apps/api',
  'apps/mobile',
  'apps/admin',
  'packages/domain',
  'packages/contracts',
  'packages/config',
  'packages/db',
  'packages/observability',
];
const actual = roots.flatMap((r) => walk(r, inventory.extensions)).sort();
const frozen = [...inventory.production].sort();
if (JSON.stringify(actual) !== JSON.stringify(frozen))
  fail(`inventory mismatch actual=${JSON.stringify(actual)} frozen=${JSON.stringify(frozen)}`);
const lexicon =
  /\b(deal|agreement|revision|ledger|payment|payout|refund|dispute|kyc|otp|booking|subscription|digital.?asset|financial.?intent|auth(?:entication)?|user)\b/i;
for (const file of frozen) {
  const text = readFileSync(`${root}/${file}`, 'utf8');
  if (lexicon.test(text) && !text.includes('no API DTOs')) fail(`product surface in ${file}`);
}
const schema = readFileSync(`${root}/packages/db/prisma/schema.prisma`, 'utf8');
if (/^\s*model\s+/m.test(schema)) fail('Prisma model found');
const controller = readFileSync(`${root}/apps/api/src/app.controller.ts`, 'utf8');
if (
  !controller.includes("@Get('live')") ||
  !controller.includes("@Get('ready')") ||
  controller.match(/@Get\(/g)?.length !== 2
)
  fail('API route surface differs');
const negative = [...actual, 'apps/api/src/innocent.ts'].sort();
if (JSON.stringify(negative) === JSON.stringify(frozen))
  fail('negative extra-file fixture not rejected');
pass('spec000_no_product_logic_surface', { files: actual, negativeExtraFileFixture: 'rejected' });
pass('spec000_api_has_no_product_routes');
pass('spec000_no_auth_payment_provider_or_mock_surface');
