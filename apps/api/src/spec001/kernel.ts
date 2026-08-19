import type { KernelPorts } from '@dhamani/domain';
import { productionKernelPorts } from './crypto.js';
import { createKernelDatabase, type KernelDatabase } from './database.js';
import { acceptCurrentRevision } from './commands/accept-current-revision.js';
import { bindCounterpartyPrincipal } from './commands/bind-counterparty-principal.js';
import { createFormalDeal } from './commands/create-formal-deal.js';
import { expireInvitationIfDue } from './commands/expire-invitation-if-due.js';
import { proposeChanges } from './commands/propose-changes.js';
import { rejectCurrentRevision } from './commands/reject-current-revision.js';
import { withdrawInvitation, withdrawNegotiation } from './commands/withdraw.js';
import { assertContractualWriteReadiness } from './readiness.js';

/**
 * The SPEC-001 application command registry (§21).
 *
 * This is the complete set of commands the kernel exposes. It is enumerated here so the
 * zero-financial-execution-surface gate can assert that no ninth command has appeared without a
 * reviewed spec, and so that "no command moves money" is checkable rather than merely asserted.
 *
 * Seven commands are keyed by `ApplicationIdempotencyRecord`; `ExpireInvitationIfDue` is
 * state-idempotent and takes no caller key (§22.1).
 */
export const SPEC001_COMMANDS = {
  AcceptCurrentRevision: acceptCurrentRevision,
  BindCounterpartyPrincipal: bindCounterpartyPrincipal,
  CreateFormalDeal: createFormalDeal,
  ExpireInvitationIfDue: expireInvitationIfDue,
  ProposeChanges: proposeChanges,
  RejectCurrentRevision: rejectCurrentRevision,
  WithdrawInvitation: withdrawInvitation,
  WithdrawNegotiation: withdrawNegotiation,
} as const;

export type Spec001CommandName = keyof typeof SPEC001_COMMANDS;

export const SPEC001_COMMAND_NAMES = Object.keys(SPEC001_COMMANDS).sort() as Spec001CommandName[];

/** Commands that consume a caller idempotency key (§22.1). */
export const SPEC001_KEYED_COMMAND_NAMES = SPEC001_COMMAND_NAMES.filter(
  (name) => name !== 'ExpireInvitationIfDue',
);

export type DealKernel = Readonly<{
  database: KernelDatabase;
  ports: KernelPorts;
  commands: typeof SPEC001_COMMANDS;
  assertReadiness: () => ReturnType<typeof assertContractualWriteReadiness>;
  close: () => Promise<void>;
}>;

export function createDealKernel(
  connectionString: string,
  ports: KernelPorts = productionKernelPorts,
): DealKernel {
  const database = createKernelDatabase(connectionString);
  return Object.freeze({
    database,
    ports,
    commands: SPEC001_COMMANDS,
    assertReadiness: () => assertContractualWriteReadiness(database),
    close: () => database.end(),
  });
}
