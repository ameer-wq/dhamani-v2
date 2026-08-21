import type { ReadinessVerdict } from '@dhamani/domain';
import { createDealKernel } from './kernel.js';

export type ContractualWriteReadiness = Readonly<{
  assert: () => Promise<ReadinessVerdict>;
  close: () => Promise<void>;
}>;

/**
 * Actual application dependency for the Frozen §24.6 runtime-credential readiness assertion.
 * Every evaluation constructs a fresh database handle from the process connection string. A
 * pooled connection or a readiness result from an earlier healthy request therefore cannot keep
 * `/health/ready` healthy after PostgreSQL becomes unavailable.
 */
export function createContractualWriteReadiness(
  connectionString: string,
): ContractualWriteReadiness {
  let closed = false;
  return Object.freeze({
    async assert(): Promise<ReadinessVerdict> {
      if (closed) throw new Error('CONTRACTUAL_WRITE_READINESS_CLOSED');
      const probe = createDealKernel(connectionString);
      try {
        return await probe.assertReadiness();
      } finally {
        await probe.close();
      }
    },
    async close(): Promise<void> {
      closed = true;
    },
  });
}
