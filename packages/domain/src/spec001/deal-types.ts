import { Spec001Error } from './errors.js';

/**
 * §3.1 — exactly these five V1 types are enabled. There is deliberately no sixth `DEPOSIT`
 * type: deposit/earnest behavior belongs inside an applicable type in a later spec.
 */
export const DEAL_TYPES = [
  'GOODS',
  'SERVICES',
  'BOOKING',
  'SUBSCRIPTION',
  'DIGITAL_ASSET',
] as const;

export type DealType = (typeof DEAL_TYPES)[number];

export const PARTY_ROLES = [
  'BUYER',
  'SELLER',
  'CLIENT',
  'SERVICE_PROVIDER',
  'CUSTOMER',
  'BOOKING_PROVIDER',
  'SUBSCRIBER',
  'SUBSCRIPTION_PROVIDER',
] as const;

export type PartyRole = (typeof PARTY_ROLES)[number];

export const SLOT_KINDS = ['CREATOR', 'COUNTERPARTY'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/**
 * §3.3 — the registry is server-owned. No client-supplied role map or type behavior is
 * authoritative, and the payer-side role is frozen here for later funding specs (§4).
 * Adding a future type is a reviewed code/schema/test/migration change, never a data toggle.
 */
export type DealTypeDefinition = Readonly<{
  dealType: DealType;
  roles: readonly [PartyRole, PartyRole];
  /** §4 payer-side role, consumed by later specs. SPEC-001 itself moves no money. */
  payerRole: PartyRole;
}>;

const REGISTRY: Readonly<Record<DealType, DealTypeDefinition>> = Object.freeze({
  GOODS: Object.freeze({
    dealType: 'GOODS',
    roles: Object.freeze(['BUYER', 'SELLER']) as unknown as readonly [PartyRole, PartyRole],
    payerRole: 'BUYER',
  }),
  SERVICES: Object.freeze({
    dealType: 'SERVICES',
    roles: Object.freeze(['CLIENT', 'SERVICE_PROVIDER']) as unknown as readonly [
      PartyRole,
      PartyRole,
    ],
    payerRole: 'CLIENT',
  }),
  BOOKING: Object.freeze({
    dealType: 'BOOKING',
    roles: Object.freeze(['CUSTOMER', 'BOOKING_PROVIDER']) as unknown as readonly [
      PartyRole,
      PartyRole,
    ],
    payerRole: 'CUSTOMER',
  }),
  SUBSCRIPTION: Object.freeze({
    dealType: 'SUBSCRIPTION',
    roles: Object.freeze(['SUBSCRIBER', 'SUBSCRIPTION_PROVIDER']) as unknown as readonly [
      PartyRole,
      PartyRole,
    ],
    payerRole: 'SUBSCRIBER',
  }),
  DIGITAL_ASSET: Object.freeze({
    dealType: 'DIGITAL_ASSET',
    roles: Object.freeze(['BUYER', 'SELLER']) as unknown as readonly [PartyRole, PartyRole],
    payerRole: 'BUYER',
  }),
});

export function isDealType(value: unknown): value is DealType {
  return typeof value === 'string' && (DEAL_TYPES as readonly string[]).includes(value);
}

export function dealTypeDefinition(dealType: DealType): DealTypeDefinition {
  const definition = REGISTRY[dealType];
  if (!definition) throw new Spec001Error('INVALID_DEAL_TYPE');
  return definition;
}

export function requireDealType(value: unknown): DealType {
  if (!isDealType(value)) throw new Spec001Error('INVALID_DEAL_TYPE');
  return value;
}

/**
 * §4 — the creator chooses only the creator-side role; the server derives the complement.
 * The client never submits two arbitrary roles.
 */
export function deriveCounterpartyRole(dealType: DealType, creatorRole: unknown): PartyRole {
  const { roles } = dealTypeDefinition(dealType);
  const [first, second] = roles;
  if (creatorRole === first) return second;
  if (creatorRole === second) return first;
  throw new Spec001Error('INVALID_DEAL_ROLE_PAIR');
}

export function isLegalRoleTriple(
  dealType: DealType,
  slotKind: SlotKind,
  role: PartyRole,
): boolean {
  if (!isDealType(dealType)) return false;
  const { roles } = REGISTRY[dealType];
  if (!roles.includes(role)) return false;
  return (SLOT_KINDS as readonly string[]).includes(slotKind);
}

export function payerRoleFor(dealType: DealType): PartyRole {
  return dealTypeDefinition(dealType).payerRole;
}

/** Every legal `(dealType, slotKind, role)` triple, used to generate the DB CHECK constraint. */
export function legalRoleTriples(): Array<{
  dealType: DealType;
  slotKind: SlotKind;
  role: PartyRole;
}> {
  const triples: Array<{ dealType: DealType; slotKind: SlotKind; role: PartyRole }> = [];
  for (const dealType of DEAL_TYPES)
    for (const slotKind of SLOT_KINDS)
      for (const role of REGISTRY[dealType].roles) triples.push({ dealType, slotKind, role });
  return triples;
}
