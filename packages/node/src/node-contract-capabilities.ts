/**
 * Runtime capability marker for the crumbtrail-node package contract.
 *
 * A consumer that cannot rely on semver alone reads this map through a
 * namespace import and enables a feature only when the corresponding key
 * reads exactly `true`. An absent or malformed marker fails closed, so this
 * module is the single source of truth and must stay a plain, statically
 * analyzable const: no computed keys, no conditional construction, nothing
 * a bundler could tree shake or reshape.
 *
 * The hosted cloud probed this map while it bridged the unpublished
 * contract. Since crumbtrail-node 0.5.0 it depends on the published package
 * directly and that probe is gone. Keys remain part of the public contract
 * byte for byte.
 */
export const NODE_CONTRACT_CAPABILITIES = {
  tenantContextFactory: true,
  ticketComment: true,
} as const;
