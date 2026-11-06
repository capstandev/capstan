// @capstan/eligibility: venue matrix (versioned, tighten-only), IP country from DB-IP Lite, the CapstanEligibility v1
// declaration, the decision engine with agent default-deny, refusal receipts and the api edge (spec 10).
// Eligibility is best effort: it never verifies identity and holds no KYC field.
export const PACKAGE_NAME = "@capstan/eligibility" as const;
export * from "./rules";
export * from "./geo";
export * from "./declaration";
export * from "./decide";
export * from "./refusal";
export * from "./edge";
export * from "./refresh";
