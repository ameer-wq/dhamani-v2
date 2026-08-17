import { fail, pass, root } from './lib.ts';
import { verifyProductionBuildTestkitAbsence } from './build-artifacts-core.ts';

try {
  pass('spec000_production_build_testkit_absence', verifyProductionBuildTestkitAbsence(root));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
