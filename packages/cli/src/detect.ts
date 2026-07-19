// Compatibility shim. Detection now lives in crumbtrail-detect-core.
export * from "crumbtrail-detect-core";
// Existing deep CLI imports use this test helper; it is intentionally absent
// from both packages' public root barrels.
export { memoryReader } from "crumbtrail-detect-core/testing";
