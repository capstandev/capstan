// Signed account reads (spec 4.4 gotcha, 13.1 POST /v1/risk/ingest; DECISIONS #33 and #60). Aster account reads need
// the user's signer, so Capstan never reads them with a key of its own:
//   direct mode: the SDK signs and sends the read itself, then posts Aster's answer here (source 'client_read');
//   relay mode:  the agent is whitelisted to the relay egress IP, so the SDK signs the read and posts only the signed
//                query; the API host (same IP) sends it to Aster byte for byte and ingests Aster's own answer
//                (source 'relay_read'). Any snapshot body the client sends in relay mode is ignored.
// Every ingest checks: the signer is an active delegation of the owner, the query names that owner and that signer,
// the signature is the signer's, and the read is under 60 s old. Snapshots stay per venue (invariant 3).
import { PUBSUB } from "@capstan/core";
import type { Redis } from "ioredis";
import { CapstanError, Dec, type AccountSnapshot, type Hex, type Order, type Position } from "@capstan/schema";
import { digestTrade, parseQuery, queryString, recoverDigestSigner, type Param } from "@capstan/signer-aster";
import type { VenueHttp } from "@capstan/venue-client";
import { assertV3Path, type AsterNetwork } from "./config";
import { asterMarketId } from "./normalize";

export type SignedReadKind = "positionRisk" | "balance" | "openOrders" | "order";
export const SIGNED_READ_PATHS: Record<SignedReadKind, string> = {
  positionRisk: "/fapi/v3/positionRisk",
  balance: "/fapi/v3/balance",
  openOrders: "/fapi/v3/openOrders",
  order: "/fapi/v3/order",
};
export const SIGNED_READ_MAX_AGE_MS = 60_000;
/** Risk (19) treats a snapshot as live for 5 s; the store keeps it 60 s so close-all can still use it. */
export const ACCOUNT_CACHE_TTL_MS = 5_000;
export const ACCOUNT_STORE_TTL_MS = SIGNED_READ_MAX_AGE_MS;

/** Under 5 s old: usable by the risk view. */
export function isRiskFresh(s: { asOf: string }, nowMs: number): boolean {
  return nowMs - Date.parse(s.asOf) <= ACCOUNT_CACHE_TTL_MS;
}
const STABLES = new Set(["USDT", "USDC", "USD1", "USDF", "U"]);

/** The SDK signs `digest` with the agent key and sends `${path}?${query}&signature=..` (or posts it to ingest). */
export function buildSignedRead(
  kind: SignedReadKind,
  owner: Hex,
  signer: Hex,
  nonce: bigint,
  network: AsterNetwork,
  extra: Param[] = [],
): { path: string; params: Param[]; query: string; digest: Hex } {
  const path = SIGNED_READ_PATHS[kind];
  if (!path) throw new CapstanError("INVALID_INPUT", "unknown read kind");
  if (kind === "order" && !extra.some(([k]) => k === "origClientOrderId" || k === "orderId")) throw new CapstanError("INVALID_INPUT", "an order read needs origClientOrderId or orderId");
  const params: Param[] = [...extra, ["asterChain", network], ["user", owner], ["signer", signer], ["nonce", nonce]];
  const query = queryString(params);
  return { path, params, query, digest: digestTrade(query, network === "Testnet" ? 714 : 1666) };
}

/** Order status after a 503: look the order up by the client id the build set. */
export function buildOrderStatusRead(owner: Hex, signer: Hex, nonce: bigint, network: AsterNetwork, symbol: string, clientOrderId: string) {
  return buildSignedRead("order", owner, signer, nonce, network, [["symbol", symbol], ["origClientOrderId", clientOrderId]]);
}

// ---------------------------------------------------------------- ports
export interface DelegationLookup {
  /** True when `signer` is an active, unexpired Aster delegation of `owner`. */
  isActive(owner: Hex, signer: Hex, nowMs: number): Promise<boolean>;
}

export interface AsterAccountState {
  snapshot: AsterAccountSnapshot;
  openOrders: Order[] | null;
}

export interface AccountSnapshotStore {
  put(owner: Hex, s: AsterAccountState, ttlMs: number): Promise<void>;
  get(owner: Hex): Promise<AsterAccountState | null>;
}

/** Redis store: one key per owner, plus a publish on the account channel for the WS gateway. */
export function redisAccountStore(redis: Redis): AccountSnapshotStore {
  const key = (o: Hex) => `acct:aster:${o.toLowerCase()}`;
  return {
    async put(owner, s, ttl) {
      const v = JSON.stringify(s);
      await redis.multi().set(key(owner), v, "PX", ttl).publish(PUBSUB.account(owner.toLowerCase()), JSON.stringify({ venue: "aster", snapshot: s.snapshot })).exec();
    },
    async get(owner) {
      const v = await redis.get(key(owner));
      return v ? (JSON.parse(v) as AsterAccountState) : null;
    },
  };
}

export interface AsterAccountSnapshot extends AccountSnapshot {
  venue: "aster";
  /** Who made the newest read that changed this snapshot. */
  source: "client_read" | "relay_read";
  /**
   * Who made the read the positions came from, and when (security r2 R2-RELAY-01). A balance read after a positions
   * read changes source and asOf but not the positions, so safety inputs (the relay's gross cap) use these instead.
   * Absent until a positionRisk read lands.
   */
  positionsSource?: "client_read" | "relay_read";
  positionsAsOf?: string;
}

export function memoryAccountStore(now: () => number = Date.now): AccountSnapshotStore {
  const m = new Map<string, { v: AsterAccountState; exp: number }>();
  return {
    async put(owner, s, ttl) {
      m.set(owner.toLowerCase(), { v: s, exp: now() + ttl });
    },
    async get(owner) {
      const e = m.get(owner.toLowerCase());
      return e && e.exp > now() ? e.v : null;
    },
  };
}

export interface IngestBody {
  venue: "aster";
  mode?: "relay" | "direct";
  snapshot?: unknown;
  signedRead: { path: string; query: string; signature: Hex; signer: Hex; owner: Hex; fetchedAtMs: number };
}

export interface IngestDeps {
  network: AsterNetwork;
  delegations: DelegationLookup;
  store: AccountSnapshotStore;
  /** Relay mode only: the API host's own Aster client (same egress IP as the relay). */
  http?: VenueHttp;
  /** marginAsset per venue symbol (from the catalog); a position keeps its own collateral asset. */
  marginAssetOf: (symbol: string) => string | null;
  now?: () => number;
}

// ---------------------------------------------------------------- normalisation of Aster account answers
interface AsterPositionRow {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit?: string;
  liquidationPrice?: string;
  leverage?: string;
  marginType?: string;
  notional?: string;
  positionSide?: string;
}
interface AsterBalanceRow {
  asset: string;
  balance: string;
  crossUnPnl?: string;
  availableBalance?: string;
}
interface AsterOrderRow {
  symbol: string;
  orderId: number | string;
  clientOrderId?: string;
  side: string;
  origQty: string;
  executedQty: string;
  price: string;
  status: string;
  time?: number;
  updateTime?: number;
}

const S = 18;
const d = (x: string | undefined) => Dec.parse(x && x !== "" ? x : "0", S, "half_even");
const str = (x: Dec) => Dec.toString(x);

export function positionsFrom(rows: AsterPositionRow[], marginAssetOf: (s: string) => string | null, asOf: string): Position[] {
  const out: Position[] = [];
  for (const r of rows) {
    const amt = d(r.positionAmt);
    if (Dec.isZero(amt)) continue;
    const liq = d(r.liquidationPrice);
    const notional = r.notional !== undefined ? Dec.abs(d(r.notional)) : Dec.abs(Dec.mul(amt, d(r.markPrice), S));
    out.push({
      venue: "aster",
      marketId: asterMarketId(r.symbol),
      canonicalAsset: null,
      side: Dec.cmp(amt, d("0")) > 0 ? "long" : "short",
      size: str(Dec.abs(amt)),
      entryPx: str(d(r.entryPrice)),
      markPx: str(d(r.markPrice)),
      notionalUsd: str(notional),
      leverage: Number(r.leverage ?? "1") || 1,
      marginMode: (r.marginType ?? "").toLowerCase() === "isolated" ? "isolated" : "cross",
      liqPx: Dec.isZero(liq) ? null : str(liq),
      liqPxSource: "venue",
      marginRatio: null,
      unrealisedPnlUsd: str(d(r.unRealizedProfit)),
      collateralAsset: marginAssetOf(r.symbol) ?? quoteOf(r.symbol),
      asOf,
    });
  }
  return out;
}

function quoteOf(symbol: string): string {
  const m = /(USDT|USDC|USD1|USDF|U)$/.exec(symbol);
  return m ? m[1]! : "UNKNOWN";
}

export function ordersFrom(rows: AsterOrderRow[]): Order[] {
  const st: Record<string, Order["status"]> = { NEW: "open", PARTIALLY_FILLED: "partial", FILLED: "filled", CANCELED: "cancelled", EXPIRED: "cancelled", REJECTED: "rejected" };
  return rows.map((r) => ({
    venue: "aster",
    marketId: asterMarketId(r.symbol),
    venueOrderId: String(r.orderId),
    ...(r.clientOrderId ? { clientOrderId: r.clientOrderId } : {}),
    side: r.side === "SELL" ? "sell" : "buy",
    size: str(d(r.origQty)),
    filled: str(d(r.executedQty)),
    px: Dec.isZero(d(r.price)) ? null : str(d(r.price)),
    status: st[r.status] ?? "open",
    builderFeeBps: 0, // the venue's order row does not carry it; reconciliation (27) does
    createdAt: new Date(Number(r.time ?? r.updateTime ?? 0)).toISOString(),
  }));
}

// ---------------------------------------------------------------- ingest
function refuse(message: string, field: string): never {
  throw new CapstanError("UNAUTHORIZED", message, { field });
}

export async function ingestSignedRead(body: IngestBody, deps: IngestDeps): Promise<AsterAccountSnapshot> {
  const now = (deps.now ?? Date.now)();
  if (body?.venue !== "aster") throw new CapstanError("UNSUPPORTED_VENUE");
  const sr = body.signedRead;
  if (!sr || typeof sr.query !== "string" || typeof sr.path !== "string") throw new CapstanError("INVALID_INPUT", "signedRead is required", { field: "signedRead" });
  const kind = (Object.keys(SIGNED_READ_PATHS) as SignedReadKind[]).find((k) => SIGNED_READ_PATHS[k] === sr.path && k !== "order");
  if (!kind) throw new CapstanError("INVALID_INPUT", "only positionRisk, balance and openOrders reads are ingested", { field: "signedRead.path" });
  assertV3Path(sr.path);
  const owner = sr.owner;
  const signer = sr.signer;
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(signer ?? "")) throw new CapstanError("INVALID_INPUT", "owner and signer must be addresses", { field: "signedRead.owner" });
  // the query must name this owner and this signer, on this network
  let q: [string, string][];
  try {
    q = parseQuery(sr.query);
  } catch {
    throw new CapstanError("INVALID_INPUT", "signedRead.query is not a query string", { field: "signedRead.query" });
  }
  const val = (k: string) => q.find(([n]) => n === k)?.[1];
  if (q.some(([k]) => k === "signature")) throw new CapstanError("INVALID_INPUT", "the query must not include the signature", { field: "signedRead.query" });
  if ((val("user") ?? "").toLowerCase() !== owner.toLowerCase()) refuse("the read names another user", "signedRead.query.user");
  if ((val("signer") ?? "").toLowerCase() !== signer.toLowerCase()) refuse("the read names another signer", "signedRead.query.signer");
  if (val("asterChain") !== deps.network) throw new CapstanError("INVALID_INPUT", "wrong network", { field: "signedRead.query.asterChain" });
  // freshness: the client's fetch time and the signed nonce (microseconds) are both under 60 s old
  if (!Number.isSafeInteger(sr.fetchedAtMs) || now - sr.fetchedAtMs > SIGNED_READ_MAX_AGE_MS || sr.fetchedAtMs - now > 5_000) refuse("the read is older than 60 s", "signedRead.fetchedAtMs");
  const nonceMs = Number(BigInt(val("nonce") ?? "0") / 1000n);
  if (Math.abs(now - nonceMs) > SIGNED_READ_MAX_AGE_MS) refuse("the signed nonce is older than 60 s", "signedRead.query.nonce");
  // the signature is the signer's, over exactly this query
  const who = recoverDigestSigner(digestTrade(sr.query, deps.network === "Testnet" ? 714 : 1666), sr.signature);
  if (!who || who.toLowerCase() !== signer.toLowerCase()) refuse("the signature is not the signer's", "signedRead.signature");
  if (!(await deps.delegations.isActive(owner, signer, now))) refuse("the signer is not an active delegation of this owner", "signedRead.signer");

  const mode = body.mode ?? "direct";
  let answer: unknown;
  let asOfMs: number;
  let source: AsterAccountSnapshot["source"];
  if (mode === "relay") {
    if (!deps.http) throw new CapstanError("INTERNAL_ERROR", "relay-mode reads need the API host's venue client");
    // byte for byte: the signed query, then the signature, nothing re-encoded
    const raw = await deps.http.request("GET", `${sr.path}?${sr.query}&signature=${sr.signature}`, { cost: 5 });
    if (raw.httpStatus < 200 || raw.httpStatus >= 300) throw new CapstanError(Number((raw.body as { code?: unknown })?.code) === -5050 ? "ASTER_DEPOSIT_REQUIRED" : "VENUE_ERROR", `venue answered ${raw.httpStatus}`);
    answer = raw.body;
    asOfMs = now;
    source = "relay_read";
  } else {
    answer = body.snapshot;
    asOfMs = sr.fetchedAtMs;
    source = "client_read";
  }
  const asOf = new Date(asOfMs).toISOString();
  const prev = await deps.store.get(owner);
  const base: AsterAccountSnapshot = prev?.snapshot ?? { venue: "aster", identity: { venue: "aster", owner, agentAddress: signer }, equityUsd: "0", freeCollateralUsd: "0", positions: [], asOf, source };
  let snapshot: AsterAccountSnapshot = { ...base, identity: { venue: "aster", owner, agentAddress: signer }, asOf, source };
  let openOrders = prev?.openOrders ?? null;
  if (kind === "positionRisk") {
    if (!Array.isArray(answer)) throw new CapstanError("INVALID_INPUT", "positionRisk answer must be an array", { field: "snapshot" });
    snapshot = { ...snapshot, positions: positionsFrom(answer as AsterPositionRow[], deps.marginAssetOf, asOf), positionsSource: source, positionsAsOf: asOf };
  } else if (kind === "balance") {
    if (!Array.isArray(answer)) throw new CapstanError("INVALID_INPUT", "balance answer must be an array", { field: "snapshot" });
    let eq = d("0");
    let free = d("0");
    for (const b of answer as AsterBalanceRow[]) {
      if (!STABLES.has(b.asset)) continue;
      eq = Dec.add(eq, Dec.add(d(b.balance), d(b.crossUnPnl)));
      free = Dec.add(free, d(b.availableBalance));
    }
    snapshot = { ...snapshot, equityUsd: str(eq), freeCollateralUsd: str(free) };
  } else {
    if (!Array.isArray(answer)) throw new CapstanError("INVALID_INPUT", "openOrders answer must be an array", { field: "snapshot" });
    openOrders = ordersFrom(answer as AsterOrderRow[]);
  }
  await deps.store.put(owner, { snapshot, openOrders }, ACCOUNT_STORE_TTL_MS);
  return snapshot;
}
