// Hosts, signing ids and chain ids per venue (verified live 2026-11-05, see the source field). Read-only facts;
// adapters take their base URLs from here unless config overrides them.
import type { BuilderFeeRail, VenueId } from "../adapter";
import type { Sourced } from "./chains";

export interface VenueHosts extends Sourced {
  venue: VenueId;
  network: "mainnet" | "testnet";
  rest: string;
  ws: string | null;
  signingChainId?: number; // Lighter signing id, Aster EIP-712 chain id for agent signatures, HL L1 phantom agent chain
  notes?: string;
}

export const VENUE_HOSTS = {
  hyperliquid: { venue: "hyperliquid", network: "mainnet", rest: "https://api.hyperliquid.xyz", ws: "wss://api.hyperliquid.xyz/ws", signingChainId: 1337, notes: "info POST /info, exchange POST /exchange; user-signed actions use domain chain id 0x66eee (421614)", source: "venue-hyperliquid.md §1, 2026-11-05" },
  hyperliquidTestnet: { venue: "hyperliquid", network: "testnet", rest: "https://api.hyperliquid-testnet.xyz", ws: "wss://api.hyperliquid-testnet.xyz/ws", signingChainId: 1337, source: "venue-hyperliquid.md §1, 2026-11-05" },
  lighterMainnet: { venue: "lighter-mainnet", network: "mainnet", rest: "https://mainnet.zklighter.elliot.ai", ws: "wss://mainnet.zklighter.elliot.ai/stream", signingChainId: 304, notes: "explorer https://explorer.elliot.ai/api/", source: "venue-lighter.md §configs, 2026-11-05" },
  lighterRh: { venue: "lighter-rh", network: "mainnet", rest: "https://api.rh.lighter.xyz", ws: "wss://api.rh.lighter.xyz/stream", signingChainId: 466324, notes: "read-only WS adds ?readonly=true; explorer https://explorerapi.rh.lighter.xyz/api/", source: "venue-lighter.md §configs, 2026-11-05" },
  lighterMainnetTestnet: { venue: "lighter-mainnet", network: "testnet", rest: "https://testnet.zklighter.elliot.ai", ws: "wss://testnet.zklighter.elliot.ai/stream", signingChainId: 300, notes: "both Lighter testnets use signing id 300: never tell them apart by chain id", source: "venue-lighter.md §configs, 2026-11-05" },
  lighterRhTestnet: { venue: "lighter-rh", network: "testnet", rest: "https://api.rh-testnet.lighter.xyz", ws: "wss://api.rh-testnet.lighter.xyz/stream", signingChainId: 300, source: "venue-lighter.md §configs, 2026-11-05" },
  aster: { venue: "aster", network: "mainnet", rest: "https://fapi.asterdex.com", ws: "wss://fstream.asterdex.com", signingChainId: 1666, notes: "V3 only (/fapi/v3/*); main-wallet management signatures use chain id 56", source: "venue-aster.md §1, 2026-11-05" },
  asterTestnet: { venue: "aster", network: "testnet", rest: "https://fapi.asterdex-testnet.com", ws: "wss://fstream.asterdex-testnet.com", signingChainId: 714, source: "venue-aster.md §1, 2026-11-05" },
  variational: { venue: "variational", network: "mainnet", rest: "https://omni-client-api.prod.ap-northeast-1.variational.io", ws: null, notes: "read-only GET /metadata/v2/stats; data is 8 to 67 s old (CDN cache)", source: "venue-readonly.md §1, 2026-11-05" },
  arcus: { venue: "arcus", network: "mainnet", rest: "https://api.arcus.xyz", ws: "wss://api.arcus.xyz/v1/ws", source: "venue-readonly.md §2.1, 2026-11-05" },
  arcusTestnet: { venue: "arcus", network: "testnet", rest: "https://api.testnet.arcus.xyz", ws: "wss://api.testnet.arcus.xyz/v1/ws", source: "venue-readonly.md §2.1, 2026-11-05" },
} as const satisfies Record<string, VenueHosts>;

/** Lighter API key indexes Capstan never uses on either config (0-3 and 157 reserved, 255 sentinel). */
export const LIGHTER_RESERVED_KEY_INDEXES = [0, 1, 2, 3, 157, 255] as const;

/** Lighter integrator rail caps (the brand charges 0 at launch). Builder address is filled from config. */
export const LIGHTER_INTEGRATOR_CAP_BPS = { "lighter-mainnet": 10, "lighter-rh": 100 } as const satisfies Partial<Record<VenueId, number>>;

export const BUILDER_FEE_DEFAULTS = {
  // HL: approval "0.03%" max, charge f=20 tenths of a bp (2 bps); lock tier f=10
  hyperliquid: { kind: "hl_builder_code", unit: "tenths_bp", capBps: 10, chargeBps: 2 },
  // Aster: maxFeeRate 0.0003, feeRate 0.0002 (2 bps); lock tier 0.0001
  aster: { kind: "aster_code", unit: "decimal_rate", capBps: 10, chargeBps: 2 },
  "lighter-mainnet": { kind: "lighter_integrator", unit: "ppm", capBps: 10, chargeBps: 0 },
  "lighter-rh": { kind: "lighter_integrator", unit: "ppm", capBps: 100, chargeBps: 0 },
} as const satisfies Partial<Record<VenueId, Omit<BuilderFeeRail, "approvalSignedBy" | "builderAddress">>>;

/** Funding normalisation facts per venue (hours). HL computes over 8 h and settles 1/8 hourly. */
export const VENUE_FUNDING_FACTS = {
  hyperliquid: { intervalS: 28800, settleIntervalS: 3600, capPerHour: "0.04", source: "venue-hyperliquid.md §3, 2026-11-05" },
  "lighter-mainnet": { intervalS: 3600, settleIntervalS: 3600, capPerHour: null, source: "venue-lighter.md §funding, 2026-11-05" },
  "lighter-rh": { intervalS: 3600, settleIntervalS: 3600, capPerHour: null, source: "venue-lighter.md §funding, 2026-11-05" },
  arcus: { intervalS: 3600, settleIntervalS: 3600, capPerHour: "0.04", source: "venue-readonly.md §2.2, 2026-11-05" },
} as const satisfies Partial<Record<VenueId, Sourced & { intervalS: number; settleIntervalS: number; capPerHour: string | null }>>;
