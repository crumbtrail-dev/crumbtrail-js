/**
 * Runtime capability marker for the crumbtrail-node package contract.
 *
 * The hosted cloud probes this map through a namespace import and enables a
 * feature only when the corresponding key reads exactly `true`. An absent or
 * malformed marker fails closed, so this module is the single source of truth
 * and must stay a plain, statically analyzable const: no computed keys, no
 * conditional construction, nothing a bundler could tree shake or reshape.
 *
 * Keys must match the cloud contract byte for byte.
 */
export const NODE_CONTRACT_CAPABILITIES = {
  tenantContextFactory: true,
  ticketComment: true,
} as const;
