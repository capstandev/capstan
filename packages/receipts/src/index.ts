// @capstan/receipts: RFC 8785 canonicalisation, receipt hash and leaf, EIP-191 signing, per-owner chain, hourly
// sorted-pair Merkle tree, proofs and full verification (spec 11). It never loads a key: callers pass a signer.
export const PACKAGE_NAME = "@capstan/receipts" as const;
export * from "./jcs";
export * from "./hash";
export * from "./sign";
export * from "./tree";
export * from "./chain";
export * from "./verify";
export * from "./actions";
export * from "./pg/store";
export * from "./service";
export * from "./validate";
