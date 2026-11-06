// @capstan/adapter-arcus: Arcus read-only adapter (data only, never executes, never touches KYC).
export const PACKAGE_NAME = "@capstan/adapter-arcus" as const;
export * from "./readonly";
export * from "./normalize";
export * from "./adapter";
