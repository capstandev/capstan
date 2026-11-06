// Lighter configs. One object carries the base URL, the WebSocket URL, the signing chain id and the governor bucket
// together, so nothing ever derives a host from a chain id (both testnets share signing id 300).
// 466324 is Lighter's L2 signing id for the Robinhood Chain exchange, not an EVM chain id; the EVM chain is l1ChainId.
import { BUILDER_FEE_DEFAULTS, VENUE_HOSTS, type Hex, type VenueCapabilities, type VenueId } from "@capstan/schema";
import type { VenueKey } from "@capstan/venue-client";

export type LighterVenue = Extract<VenueId, "lighter-mainnet" | "lighter-rh">;
export type LighterConfigName = "mainnet" | "rh" | "mainnetTestnet" | "rhTestnet";
export type LighterSigningId = 304 | 466324 | 300;

export interface LighterConfig {
  name: LighterConfigName;
  venue: LighterVenue;
  network: "mainnet" | "testnet";
  signingChainId: LighterSigningId;
  rest: string;
  ws: string;
  /** The read-only stream for refused regions (data only). */
  readonlyWs: string;
  explorer: string;
  /** EVM chain the exchange settles on: Ethereum 1 for mainnet, Robinhood Chain 4663 for RH. Testnets: VERIFY. */
  l1ChainId: 1 | 4663 | 11155111 | 46630;
  collateral: "USDC" | "USDG";
  governorKey: VenueKey;
  /** Human name used in wallet prompts (the ChangePubKey message carries no chain id or exchange name). */
  exchangeName: string;
}

const ro = (ws: string) => `${ws}?readonly=true`;

export const LIGHTER_CONFIGS: Readonly<Record<LighterConfigName, Readonly<LighterConfig>>> = Object.freeze({
  mainnet: Object.freeze({
    name: "mainnet",
    venue: "lighter-mainnet",
    network: "mainnet",
    signingChainId: 304,
    rest: VENUE_HOSTS.lighterMainnet.rest,
    ws: VENUE_HOSTS.lighterMainnet.ws,
    readonlyWs: ro(VENUE_HOSTS.lighterMainnet.ws),
    explorer: "https://explorer.elliot.ai/api/",
    l1ChainId: 1,
    collateral: "USDC",
    governorKey: "lighter-304",
    exchangeName: "Lighter mainnet",
  }),
  rh: Object.freeze({
    name: "rh",
    venue: "lighter-rh",
    network: "mainnet",
    signingChainId: 466324,
    rest: VENUE_HOSTS.lighterRh.rest,
    ws: VENUE_HOSTS.lighterRh.ws,
    readonlyWs: ro(VENUE_HOSTS.lighterRh.ws),
    explorer: "https://explorerapi.rh.lighter.xyz/api/",
    l1ChainId: 4663,
    collateral: "USDG",
    governorKey: "lighter-466324",
    exchangeName: "Lighter on Robinhood Chain",
  }),
  mainnetTestnet: Object.freeze({
    name: "mainnetTestnet",
    venue: "lighter-mainnet",
    network: "testnet",
    signingChainId: 300,
    rest: VENUE_HOSTS.lighterMainnetTestnet.rest,
    ws: VENUE_HOSTS.lighterMainnetTestnet.ws,
    readonlyWs: ro(VENUE_HOSTS.lighterMainnetTestnet.ws),
    explorer: "",
    l1ChainId: 11155111, // VERIFY with the testnet /info
    collateral: "USDC",
    governorKey: "lighter-300",
    exchangeName: "Lighter testnet",
  }),
  rhTestnet: Object.freeze({
    name: "rhTestnet",
    venue: "lighter-rh",
    network: "testnet",
    signingChainId: 300,
    rest: VENUE_HOSTS.lighterRhTestnet.rest,
    ws: VENUE_HOSTS.lighterRhTestnet.ws,
    readonlyWs: ro(VENUE_HOSTS.lighterRhTestnet.ws),
    explorer: "",
    l1ChainId: 46630, // VERIFY with the testnet /info
    collateral: "USDG",
    governorKey: "lighter-300",
    exchangeName: "Lighter on Robinhood Chain testnet",
  }),
});

/** Pick a config by its name. There is deliberately no lookup by chain id. */
export function lighterConfig(name: LighterConfigName): Readonly<LighterConfig> {
  const c = LIGHTER_CONFIGS[name];
  if (!c) throw new Error(`unknown Lighter config ${String(name)}`);
  return c;
}

export function isLighterVenue(v: VenueId): v is LighterVenue {
  return v === "lighter-mainnet" || v === "lighter-rh";
}

/**
 * Execution switch. Off by default: LIGHTER_EXECUTION=1 turns builds on once the onboarding and order paths ship and
 * pass on testnet. Reads, quotes and the catalog work either way.
 */
export function lighterExecutionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LIGHTER_EXECUTION === "1";
}

/** Brand integrator owner is not known until Capstan's integrator account exists (BACKLOG); zero until then. */
export const LIGHTER_INTEGRATOR_PLACEHOLDER: Hex = "0x0000000000000000000000000000000000000000";

export function lighterCaps(cfg: Readonly<LighterConfig>, opts: { execution?: boolean; integratorOwner?: Hex } = {}): VenueCapabilities {
  const rail = BUILDER_FEE_DEFAULTS[cfg.venue];
  return {
    venue: cfg.venue,
    execution: opts.execution ?? lighterExecutionEnabled(),
    keyType: "lighter-native",
    delegation: "api_key_index",
    canWithdraw: false,
    builderFee: { kind: rail.kind, unit: rail.unit, capBps: rail.capBps, chargeBps: rail.chargeBps, approvalSignedBy: "main_wallet", builderAddress: opts.integratorOwner ?? LIGHTER_INTEGRATOR_PLACEHOLDER },
    collateral: cfg.venue === "lighter-rh" ? ["USDG", "STOCK_TOKENS"] : ["USDC"],
    directSubmitSupported: true,
    publicAccountReads: true,
    signingDomain: { chainId: cfg.signingChainId },
  };
}
