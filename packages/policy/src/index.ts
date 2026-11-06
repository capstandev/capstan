// @capstan/policy: agent-safe mode (spec 7.6). CapstanAgentPolicy typed data, the pure policy check the relay and
// the SDK share, the stored-policy rules, the Redis kill switch and the kill response (revocations, close-alls).
export const PACKAGE_NAME = "@capstan/policy" as const;
export * from "./typed";
export * from "./check";
export * from "./store";
export * from "./kill";
