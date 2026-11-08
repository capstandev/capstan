// Per-role configuration from environment variables, validated with zod. A role never requires another role's
// variables. Errors list variable NAMES only, never a value. Safe defaults (DEP-6): every arming and mainnet flag is
// off unless set, limits are always set, the access-credit share is off, and the x402 mainnet EIP-3009 path is off.
// Raw key variables are refused: service keys load only through keystoreSigner from a path (local chain 31337 may use
// the dev signer instead).
import { z } from "zod";
import { applyForkDeployments } from "./fork";

export type Role = "api" | "ws" | "relay" | "mcp" | "workers" | "facilitator";
export const ROLES: readonly Role[] = ["api", "ws", "relay", "mcp", "workers", "facilitator"];

export class ConfigError extends Error {
  readonly names: string[];
  constructor(role: Role, names: string[], kind: "missing or invalid" | "refused") {
    super(`config(${role}): ${kind}: ${names.join(", ")}`);
    this.name = "ConfigError";
    this.names = names;
  }
}

const flag = (def: boolean) =>
  z
    .enum(["0", "1", "true", "false"])
    .default(def ? "1" : "0")
    .transform((v) => v === "1" || v === "true");
const port = (def: number) => z.coerce.number().int().min(1).max(65535).default(def);
const posInt = (def: number) => z.coerce.number().int().min(1).default(def);
const url = z.string().url();
const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, "postgres url");
const redisUrl = z.string().regex(/^rediss?:\/\//, "redis url");
const network = z.enum(["local", "testnet", "mainnet"]).default("local");
const chainId = z.coerce.number().int().positive();
const path = z.string().min(1);

const common = {
  CAPSTAN_NETWORK: network,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PUBLIC_API_HOST: z.string().regex(/^[a-z0-9.-]+(:\d+)?$/).default("localhost:8710"),
  // telemetry (packages/telemetry telemetryEnv): span file and the /metrics listener port; unset means off
  OTLP_FILE: z.string().min(1).optional(),
  PROM_PORT: z.coerce.number().int().min(1).max(65535).optional(),
};

// A service signer is either a keystore (path + password file) or, on the local chain only, the dev signer.
const signerKind = z.enum(["keystore", "dev"]).default("keystore");

/**
 * CAPSTAN_WEB_ORIGINS: the comma list of exact web origins the API answers CORS for (scheme, host, optional port; no
 * path, no wildcard, no credentials). Empty means no CORS. A bad entry refuses the boot rather than opening more.
 */
export function parseWebOrigins(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v) continue;
    if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(v)) throw new Error("web origin must be scheme://host[:port], no path and no wildcard");
    const u = new URL(v);
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("web origin must be scheme://host[:port]");
    const o = u.origin.toLowerCase();
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

const webOrigins = z
  .string()
  .default("")
  .transform((s, ctx) => {
    try {
      return parseWebOrigins(s);
    } catch {
      ctx.addIssue({ code: "custom", message: "web origins" });
      return z.NEVER;
    }
  });

// Eligibility inputs (spec 10). The DB-IP country file lives in CAPSTAN_GEO_DIR (the geo-db-refresh job writes it, the
// api edge and the relay re-check read it). CAPSTAN_TRUST_FORWARDED_FOR=1 makes the api read the caller from the first
// X-Forwarded-For entry; set it only behind the TLS front end, which overwrites that header. Off, behind a proxy every
// caller is 127.0.0.1 (a private range, no country) and every write is refused.
const geoDir = path.default("var/geo");

// One egress label per host for every venue governor (security r2 D2-ADP-06): api, relay and workers on one IP must
// name it the same, so they share that IP's venue budgets. Required (not "local") on mainnet; see egressIdOf.
const egressId = z.string().min(1).regex(/^[A-Za-z0-9._-]{1,64}$/, "egress label").default("local");
const EGRESS_ROLES = new Set<string>(["api", "relay", "workers"]);

const ROLE_SCHEMAS = {
  api: z.object({
    ...common,
    API_PORT: port(8710),
    DATABASE_URL: pgUrl,
    REDIS_URL: redisUrl,
    RATE_LIMIT_FREE_PER_MIN: posInt(60),
    RATE_LIMIT_WRITE_PER_MIN: posInt(20),
    STAKER_BUCKET_ENABLED: flag(false),
    EQ_EXECUTION_ALLOWED: flag(false),
    X402_ENABLED: flag(false),
    FACILITATOR_URL: url.default("http://127.0.0.1:8714"),
    // the x402 gate offers the USDG eip3009 rail on mainnet only with this switch (packages/x402/src/accepts.ts)
    X402_USDG_EIP3009_MAINNET: flag(false),
    // the dashboard's origins (exact match, apps/api/src/cors.ts); empty = no CORS
    CAPSTAN_WEB_ORIGINS: webOrigins,
    CAPSTAN_TRUST_FORWARDED_FOR: flag(false),
    CAPSTAN_GEO_DIR: geoDir,
    CAPSTAN_EGRESS_ID: egressId,
  }),
  ws: z.object({
    ...common,
    WS_PORT: port(8711),
    REDIS_URL: redisUrl,
    WS_MAX_SUBS_PER_CONN: posInt(50),
  }),
  relay: z.object({
    ...common,
    RELAY_PORT: port(8712),
    DATABASE_URL: pgUrl,
    REDIS_URL: redisUrl,
    CAPSTAN_EGRESS_ID: egressId,
    RELAY_FREE_ORDERS_PER_MIN: posInt(2),
    RELAY_SUBMIT_ARMED: flag(false),
    // "none": the relay holds no key and receipts are signed by the receipt-sign job (the VPS relay env sets it)
    RECEIPT_SIGNER: z.enum(["keystore", "dev", "none"]).default("keystore"),
    RECEIPT_KEYSTORE_PATH: path.optional(),
    RECEIPT_KEYSTORE_PASSWORD_FILE: path.optional(),
    RECEIPT_CHAIN_ID: chainId.default(31337),
    CAPSTAN_GEO_DIR: geoDir,
  }),
  mcp: z.object({
    ...common,
    MCP_PORT: port(8713),
    API_BASE_URL: url.default("http://127.0.0.1:8710/v1"),
    MCP_RATE_LIMIT_PER_MIN: posInt(60),
    // paid tools (x402 over MCP, apps/mcp/src/payments.ts): off unless set, plus payTo and CAPSTAN_INTERNAL_TOKEN
    X402_ENABLED: flag(false),
    FACILITATOR_URL: url.default("http://127.0.0.1:8714"),
    X402_USDG_EIP3009_MAINNET: flag(false),
    // request_logs for the usage report (MCP tool calls, hashed client ids); unset means no request log
    DATABASE_URL: pgUrl.optional(),
  }),
  workers: z.object({
    ...common,
    DATABASE_URL: pgUrl,
    REDIS_URL: redisUrl,
    WORKER_JOBS: z.string().default(""),
    CAPSTAN_EGRESS_ID: egressId,
    ANCHOR_RPC_URL: url.default("http://127.0.0.1:8545"),
    ANCHOR_ARMED: flag(false),
    // mainnet posting also needs this file to exist (set only in the production env; todo 28 R14)
    ANCHOR_ARMED_FILE: path.optional(),
    // poster balance alert threshold; default = 30 days of hourly posts at the measured fork gas (todo 28 R8)
    ANCHOR_MIN_BALANCE_WEI: z.string().regex(/^\d+$/, "wei integer").default("2500000000000000"),
    STAKER_BUCKET_ENABLED: flag(false),
    ANCHOR_SIGNER: signerKind,
    ANCHOR_KEYSTORE_PATH: path.optional(),
    ANCHOR_KEYSTORE_PASSWORD_FILE: path.optional(),
    ANCHOR_CHAIN_ID: chainId.default(31337),
    // the receipt-sign job signs receipts in the workers role too (todo 28); "none" (the default here) means this
    // worker process does not sign receipts, and the receipt-sign job refuses to start
    RECEIPT_SIGNER: z.enum(["keystore", "dev", "none"]).default("none"),
    RECEIPT_KEYSTORE_PATH: path.optional(),
    RECEIPT_KEYSTORE_PASSWORD_FILE: path.optional(),
    RECEIPT_CHAIN_ID: chainId.default(31337),
    // ops jobs (log-retention, ops-alerts, usage-daily); unarmed alerts are logged, never sent
    ALERTS_ARMED: flag(false),
    ALERTS_TOKEN_FILE: path.optional(),
    ALERTS_CHAT_ID: z.string().regex(/^-?\d+$/, "telegram chat id").optional(),
    ALERTS_TELEGRAM_API: url.optional(),
    HL_BUILDER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address").optional(),
    OPS_KNOWN_ADDRESSES: z.string().regex(/^0x[0-9a-fA-F]{40}(\s*,\s*0x[0-9a-fA-F]{40})*$/, "comma list of addresses").optional(),
    LOG_DIR: path.optional(),
    CAPSTAN_GEO_DIR: geoDir,
  }),
  facilitator: z.object({
    ...common,
    FACILITATOR_PORT: port(8714),
    DATABASE_URL: pgUrl,
    REDIS_URL: redisUrl,
    // mainnet settles need X402_SETTLE_ARMED=1 AND the file X402_SETTLE_ARMED_FILE names (apps/facilitator/src/env.ts)
    X402_SETTLE_ARMED: flag(false),
    X402_SETTLE_ARMED_FILE: path.optional(),
    X402_USDG_EIP3009_MAINNET: flag(false),
    FACILITATOR_FLOAT_MAX_USD: posInt(200),
    FACILITATOR_SIGNER: signerKind,
    FACILITATOR_KEYSTORE_PATH: path.optional(),
    FACILITATOR_KEYSTORE_PASSWORD_FILE: path.optional(),
    FACILITATOR_CHAIN_ID: chainId.default(31337),
  }),
} as const;

export type ConfigFor<R extends Role> = z.infer<(typeof ROLE_SCHEMAS)[R]> & { role: R };
export type Config = { [R in Role]: ConfigFor<R> }[Role];

const SIGNER_PREFIXES = ["RECEIPT", "ANCHOR", "FACILITATOR"] as const;

/** Env names that look like a raw key and are always refused (keys come from keystore files only). */
const RAW_KEY_NAME = /(^|_)(PRIVATE_?KEY|PRIV_?KEY|MNEMONIC|SEED|SEED_PHRASE)($|_)/i;

export function loadConfig<R extends Role>(role: R, env: Record<string, string | undefined> = process.env): ConfigFor<R> {
  // a fork stack (ops/fork) adds its throwaway contract record before anything reads DEPLOYMENTS
  if (env.CAPSTAN_FORK_DEPLOYMENTS) applyForkDeployments(env);
  const schema = ROLE_SCHEMAS[role];
  if (!schema) throw new Error(`config: unknown role ${String(role)}`);
  const refused = Object.keys(env).filter((k) => RAW_KEY_NAME.test(k) && env[k] !== undefined && env[k] !== "");
  if (refused.length) throw new ConfigError(role, refused.sort(), "refused");
  const keys = Object.keys(schema.shape);
  const input: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") input[k] = v;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const names = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "?")));
    // report the keystore paths too, so one boot attempt lists everything that is missing
    for (const p of SIGNER_PREFIXES) {
      const fallback = role === "workers" && p === "RECEIPT" ? "none" : "keystore";
      if (!(`${p}_SIGNER` in schema.shape) || (input[`${p}_SIGNER`] ?? fallback) !== "keystore") continue;
      for (const n of [`${p}_KEYSTORE_PATH`, `${p}_KEYSTORE_PASSWORD_FILE`]) if (!input[n]) names.add(n);
    }
    throw new ConfigError(role, [...names].sort(), "missing or invalid");
  }
  const cfg = parsed.data as Record<string, unknown>;
  // Signer rule: keystore needs both paths; dev is allowed only on the local chain 31337.
  for (const p of SIGNER_PREFIXES) {
    if (!(`${p}_SIGNER` in cfg)) continue;
    const kind = cfg[`${p}_SIGNER`];
    const cid = cfg[`${p}_CHAIN_ID`];
    if (kind === "dev" && cid !== 31337) throw new ConfigError(role, [`${p}_SIGNER`, `${p}_CHAIN_ID`], "refused");
    if (kind === "keystore") {
      const missing = [`${p}_KEYSTORE_PATH`, `${p}_KEYSTORE_PASSWORD_FILE`].filter((n) => !cfg[n]);
      if (missing.length) throw new ConfigError(role, missing, "missing or invalid");
    }
  }
  // A broadcaster armed for a mainnet chain id needs CAPSTAN_NETWORK=mainnet said explicitly.
  for (const [armed, chain] of [["ANCHOR_ARMED", "ANCHOR_CHAIN_ID"], ["X402_SETTLE_ARMED", "FACILITATOR_CHAIN_ID"]] as const) {
    const cid = cfg[chain];
    if (cfg[armed] === true && (cid === 4663 || cid === 8453) && cfg.CAPSTAN_NETWORK !== "mainnet") {
      throw new ConfigError(role, [armed, chain, "CAPSTAN_NETWORK"], "refused");
    }
  }
  // mainnet: every service that talks to a venue names the host's egress label (D2-ADP-06)
  if (EGRESS_ROLES.has(role) && cfg.CAPSTAN_NETWORK === "mainnet") {
    const label = env.CAPSTAN_EGRESS_ID?.trim() || env.RELAY_EGRESS_ID?.trim() || "local"; // the egressIdOf rule
    if (label === "local") throw new ConfigError(role, ["CAPSTAN_EGRESS_ID"], "missing or invalid");
  }
  return { ...(cfg as object), role } as ConfigFor<R>;
}

/**
 * Variables the server env template of a role must set explicitly (ops/server/etc/*.env), because the local default
 * is wrong on the server: the ports, data stores and telemetry outputs, the network, and for the api the proxy and
 * geo settings without which every write is refused. Plus every variable the schema itself requires.
 */
export const SERVER_ENV: Record<Role, readonly string[]> = {
  api: ["CAPSTAN_NETWORK", "PUBLIC_API_HOST", "OTLP_FILE", "PROM_PORT", "API_PORT", "DATABASE_URL", "REDIS_URL", "CAPSTAN_TRUST_FORWARDED_FOR", "CAPSTAN_GEO_DIR", "RECEIPT_SIGNERS", "ANCHOR_RPC_URL", "CAPSTAN_EGRESS_ID"],
  ws: ["CAPSTAN_NETWORK", "PUBLIC_API_HOST", "OTLP_FILE", "PROM_PORT", "WS_PORT", "REDIS_URL", "DATABASE_URL", "CAPSTAN_TRUST_FORWARDED_FOR"],
  relay: ["CAPSTAN_NETWORK", "PUBLIC_API_HOST", "OTLP_FILE", "PROM_PORT", "RELAY_PORT", "DATABASE_URL", "REDIS_URL", "CAPSTAN_EGRESS_ID", "RELAY_SUBMIT_ARMED", "CAPSTAN_GEO_DIR"],
  mcp: ["CAPSTAN_NETWORK", "PUBLIC_API_HOST", "OTLP_FILE", "PROM_PORT", "MCP_PORT", "API_BASE_URL", "DATABASE_URL"],
  workers: ["CAPSTAN_NETWORK", "PUBLIC_API_HOST", "OTLP_FILE", "PROM_PORT", "DATABASE_URL", "REDIS_URL", "WORKER_JOBS", "CAPSTAN_EGRESS_ID"],
  facilitator: ["CAPSTAN_NETWORK", "PUBLIC_API_HOST", "OTLP_FILE", "PROM_PORT", "FACILITATOR_PORT", "DATABASE_URL", "REDIS_URL", "X402_SETTLE_ARMED"],
};

/** Names a role's schema requires (no default, not optional): a missing one stops the service at boot. */
export function requiredConfigNames(role: Role): string[] {
  const shape = ROLE_SCHEMAS[role].shape as Record<string, z.ZodTypeAny>;
  return Object.keys(shape)
    .filter((k) => !shape[k]!.isOptional())
    .sort();
}

/** Variable names a role reads (for docs and the .env.example check). */
export function configNames(role: Role): string[] {
  return Object.keys(ROLE_SCHEMAS[role].shape).sort();
}
