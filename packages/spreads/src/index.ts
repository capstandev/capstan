// @capstan/spreads: funding-rate spread trades (at-risk). Legging risk is yours. Scanner over approved equivalences,
// planner, acks and events on the server; the executor runs only where the keys are (SDK or MCP host).
export const PACKAGE_NAME = "@capstan/spreads" as const;
export * from "./breakeven";
export * from "./cost";
export * from "./scan";
export * from "./catalog";
export * from "./plan";
export * from "./events";
// The executor is NOT exported here: it runs only where the keys are (SDK or MCP host) and is loaded by its own path.
