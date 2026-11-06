// Aster network configuration (venue-aster.md section 1). Only two REST hosts are ever used: the mainnet and testnet
// fapi hosts. Any other host, including the alternative host in the venue's Python example (403 from our egress), is
// refused. Every path is under /fapi/v3: the venue removed V1 on 2026-11-02 even though it still answers.
import { BUILDER_FEE_DEFAULTS, VENUE_HOSTS, type Hex, type VenueCapabilities } from "@capstan/schema";

export type AsterNetwork = "Mainnet" | "Testnet";
export type AsterRest = "https://fapi.asterdex.com" | "https://fapi.asterdex-testnet.com";

export interface AsterConfig {
  network: AsterNetwork;
  rest: AsterRest;
  ws: string;
  tradeChainId: 1666 | 714; // Mode B (agent signs the query string)
  mgmtChainId: 56; // Mode A (main wallet signs approve/update/delete)
  governorKey: "aster" | "aster-testnet";
}

export const ASTER_MAINNET: AsterConfig = Object.freeze({
  network: "Mainnet",
  rest: VENUE_HOSTS.aster.rest,
  ws: VENUE_HOSTS.aster.ws,
  tradeChainId: 1666,
  mgmtChainId: 56,
  governorKey: "aster",
});

export const ASTER_TESTNET: AsterConfig = Object.freeze({
  network: "Testnet",
  rest: VENUE_HOSTS.asterTestnet.rest,
  ws: VENUE_HOSTS.asterTestnet.ws,
  tradeChainId: 714,
  mgmtChainId: 56,
  governorKey: "aster-testnet",
});

export const ASTER_REST_HOSTS: readonly string[] = [ASTER_MAINNET.rest, ASTER_TESTNET.rest];
export const ASTER_WS_HOSTS: readonly string[] = [ASTER_MAINNET.ws, ASTER_TESTNET.ws, "wss://fstream5.asterdex-testnet.com"];

/** Every REST path the adapter may call starts with this prefix. */
export const ASTER_V3_PREFIX = "/fapi/v3/";

export class AsterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsterConfigError";
  }
}

/** Refuse any host outside the allow-list and any mismatch between network, chain id and governor key. */
export function validateAsterConfig(cfg: AsterConfig): AsterConfig {
  const rest = String(cfg.rest).replace(/\/+$/, "");
  if (!ASTER_REST_HOSTS.includes(rest)) throw new AsterConfigError(`aster: REST host not allowed: ${rest}`);
  if (!ASTER_WS_HOSTS.includes(String(cfg.ws).replace(/\/+$/, ""))) throw new AsterConfigError(`aster: WS host not allowed: ${cfg.ws}`);
  const want = cfg.network === "Mainnet" ? ASTER_MAINNET : cfg.network === "Testnet" ? ASTER_TESTNET : null;
  if (!want) throw new AsterConfigError(`aster: unknown network ${String(cfg.network)}`);
  if (rest !== want.rest) throw new AsterConfigError(`aster: ${cfg.network} must use ${want.rest}`);
  if (cfg.tradeChainId !== want.tradeChainId) throw new AsterConfigError(`aster: ${cfg.network} trade chain id is ${want.tradeChainId}`);
  if (cfg.mgmtChainId !== 56) throw new AsterConfigError("aster: management chain id is 56");
  if (cfg.governorKey !== want.governorKey) throw new AsterConfigError(`aster: ${cfg.network} governor key is ${want.governorKey}`);
  return cfg;
}

export function asterConfig(network: AsterNetwork): AsterConfig {
  return network === "Testnet" ? ASTER_TESTNET : ASTER_MAINNET;
}

/** Refuse any path outside /fapi/v3 (V1 is removed; spot sapi is out of scope). */
export function assertV3Path(path: string): string {
  if (!path.startsWith(ASTER_V3_PREFIX)) throw new AsterConfigError(`aster: only ${ASTER_V3_PREFIX}* paths are used, got ${path}`);
  return path;
}

/** Execution flag: off unless ASTER_EXECUTION is 1 or true. */
export function asterExecutionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.ASTER_EXECUTION;
  return v === "1" || v === "true";
}

/** Brand fee defaults (DECISIONS #15): approval ceiling 0.0003, charge 0.0002, lock tier 0.0001; venue cap 0.001. */
export const ASTER_FEES = Object.freeze({
  maxFeeRate: "0.0003",
  feeRate: "0.0002",
  lockFeeRate: "0.0001",
  venueCapRate: "0.001",
});

/**
 * Venue capabilities. Execution stays off until the ASTER_EXECUTION flag is set (orders land in todo 15). Account
 * reads are never public: positions come only from reads the user's own signer made.
 */
export function asterCaps(builderAddress: Hex, opts: { execution?: boolean; network?: AsterNetwork } = {}): VenueCapabilities {
  const network = opts.network ?? "Mainnet";
  return {
    venue: "aster",
    execution: opts.execution ?? asterExecutionEnabled(),
    keyType: "secp256k1",
    delegation: "agent",
    canWithdraw: false,
    builderFee: {
      kind: BUILDER_FEE_DEFAULTS.aster.kind,
      unit: BUILDER_FEE_DEFAULTS.aster.unit,
      capBps: BUILDER_FEE_DEFAULTS.aster.capBps,
      chargeBps: BUILDER_FEE_DEFAULTS.aster.chargeBps,
      approvalSignedBy: "main_wallet",
      builderAddress,
    },
    collateral: ["USDT", "USD1", "USDC", "U"],
    directSubmitSupported: true,
    publicAccountReads: false,
    signingDomain: { chainId: network === "Testnet" ? 714 : 1666, name: "AsterSignTransaction" },
  };
}
