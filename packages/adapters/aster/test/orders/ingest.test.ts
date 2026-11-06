// R7, R8, R14 (todo 15): signed account reads are checked, kept per venue, and relay-mode reads are forwarded as is.
import { CapstanError, type Hex } from "@capstan/schema";
import { accountSigner } from "@capstan/signer-aster";
import { createMemoryGovernor, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { describe, expect, test } from "bun:test";
import { buildSignedRead, ingestSignedRead, memoryAccountStore, type IngestBody, type IngestDeps } from "../../src/signedread";
import { agent, NOW, owner } from "./setup";
import { testAccount } from "../../../../signers/aster/test/keys";

const stranger = testAccount("builder");
const POSITIONS = [
  { symbol: "BTCUSDT", positionAmt: "0.010", entryPrice: "70000", markPrice: "76000", unRealizedProfit: "60", liquidationPrice: "40000", leverage: "5", marginType: "cross", notional: "760", positionSide: "BOTH" },
  { symbol: "ETHUSD1", positionAmt: "-1.5", entryPrice: "2300", markPrice: "2245", unRealizedProfit: "82.5", liquidationPrice: "0", leverage: "3", marginType: "isolated", notional: "-3367.5", positionSide: "BOTH" },
  { symbol: "SOLUSDT", positionAmt: "0", entryPrice: "0", markPrice: "180", unRealizedProfit: "0", liquidationPrice: "0", leverage: "10", marginType: "cross", notional: "0", positionSide: "BOTH" },
];
const MARGIN: Record<string, string> = { BTCUSDT: "USDT", ETHUSD1: "USD1" };

async function signedRead(kind: "positionRisk" | "balance" | "openOrders", over: { owner?: Hex; signer?: typeof agent; nowMs?: number; queryOwner?: Hex } = {}) {
  const signer = over.signer ?? agent;
  const r = buildSignedRead(kind, over.queryOwner ?? over.owner ?? owner.address, signer.address, BigInt(over.nowMs ?? NOW) * 1000n, "Mainnet");
  const signature = await accountSigner(signer)(r.digest);
  return { path: r.path, query: r.query, signature, signer: signer.address, owner: over.owner ?? owner.address, fetchedAtMs: over.nowMs ?? NOW };
}

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    network: "Mainnet",
    delegations: { isActive: async (o, s) => o.toLowerCase() === owner.address.toLowerCase() && s.toLowerCase() === agent.address.toLowerCase() },
    store: memoryAccountStore(() => NOW),
    marginAssetOf: (s) => MARGIN[s] ?? null,
    now: () => NOW,
    ...over,
  };
}

const code = (p: Promise<unknown>) => p.then(() => null, (e: CapstanError) => e.code);

describe("aster ingest", () => {
  test("refuse-foreign-or-stale", async () => {
    const ok: IngestBody = { venue: "aster", snapshot: POSITIONS, signedRead: await signedRead("positionRisk") };
    expect((await ingestSignedRead(ok, deps())).positions.length).toBe(2);
    // the signer is not a delegation of this owner
    expect(await code(ingestSignedRead({ ...ok, signedRead: await signedRead("positionRisk", { signer: stranger }) }, deps()))).toBe("UNAUTHORIZED");
    // the query names another user
    const foreign = await signedRead("positionRisk", { queryOwner: stranger.address });
    expect(await code(ingestSignedRead({ ...ok, signedRead: { ...foreign, owner: owner.address } }, deps()))).toBe("UNAUTHORIZED");
    // older than 60 s (fetch time, and the signed nonce)
    expect(await code(ingestSignedRead({ ...ok, signedRead: await signedRead("positionRisk", { nowMs: NOW - 60_001 }) }, deps()))).toBe("UNAUTHORIZED");
    expect(await code(ingestSignedRead({ ...ok, signedRead: { ...(await signedRead("positionRisk", { nowMs: NOW - 120_000 })), fetchedAtMs: NOW } }, deps()))).toBe("UNAUTHORIZED");
    // a signature that is not the signer's over this query
    const sr = await signedRead("positionRisk");
    expect(await code(ingestSignedRead({ ...ok, signedRead: { ...sr, query: sr.query.replace("asterChain=Mainnet", "asterChain=Mainnet&x=1") } }, deps()))).toBe("UNAUTHORIZED");
    expect(await code(ingestSignedRead({ ...ok, signedRead: { ...sr, signature: (await signedRead("positionRisk", { nowMs: NOW - 1 })).signature } }, deps()))).toBe("UNAUTHORIZED");
    // a revoked delegation
    expect(await code(ingestSignedRead(ok, deps({ delegations: { isActive: async () => false } })))).toBe("UNAUTHORIZED");
    // wrong path or venue
    expect(await code(ingestSignedRead({ ...ok, signedRead: { ...sr, path: "/fapi/v3/order" } }, deps()))).toBe("INVALID_INPUT");
    expect(await code(ingestSignedRead({ ...ok, venue: "hyperliquid" as never }, deps()))).toBe("UNSUPPORTED_VENUE");
  });

  test("per-venue", async () => {
    const d = deps();
    const s = await ingestSignedRead({ venue: "aster", snapshot: POSITIONS, signedRead: await signedRead("positionRisk") }, d);
    expect(s.venue).toBe("aster");
    expect(s.source).toBe("client_read");
    const btc = s.positions.find((p) => p.marketId === "aster:-:BTCUSDT")!;
    const eth = s.positions.find((p) => p.marketId === "aster:-:ETHUSD1")!;
    expect(btc).toMatchObject({ side: "long", size: "0.01", liqPx: "40000", liqPxSource: "venue", collateralAsset: "USDT", marginMode: "cross", notionalUsd: "760" });
    expect(eth).toMatchObject({ side: "short", size: "1.5", liqPx: null, liqPxSource: "venue", collateralAsset: "USD1", marginMode: "isolated", notionalUsd: "3367.5" });
    expect(s.positions.every((p) => p.venue === "aster")).toBe(true);
    // a balance read fills equity for the same venue account only, keeping the positions
    const b = await ingestSignedRead({ venue: "aster", snapshot: [{ asset: "USDT", balance: "1000", crossUnPnl: "60", availableBalance: "800" }, { asset: "USD1", balance: "50", availableBalance: "50" }, { asset: "BTC", balance: "1" }], signedRead: await signedRead("balance") }, d);
    expect(b).toMatchObject({ equityUsd: "1110", freeCollateralUsd: "850" });
    expect(b.positions.length).toBe(2);
    expect(Object.keys(b).sort()).toEqual(["asOf", "equityUsd", "freeCollateralUsd", "identity", "positions", "source", "venue"]);
    const st = await d.store.get(owner.address);
    expect(st!.snapshot.identity).toEqual({ venue: "aster", owner: owner.address, agentAddress: agent.address });
  });

  test("relay-mode-forwards-signed-read", async () => {
    const seen: string[] = [];
    const venueAnswer = [POSITIONS[0]];
    const server = fakeVenueServer({
      "GET /fapi/v3/positionRisk": (r) => {
        seen.push(new URL(r.url).search.slice(1));
        return Response.json(venueAnswer);
      },
    });
    try {
      const http = venueHttp("aster", server.url, createMemoryGovernor("t"));
      const sr = await signedRead("positionRisk");
      // the client also sends a made-up snapshot: ignored in relay mode
      const s = await ingestSignedRead({ venue: "aster", mode: "relay", snapshot: POSITIONS, signedRead: sr }, deps({ http }));
      expect(seen).toEqual([`${sr.query}&signature=${sr.signature}`]); // byte for byte
      expect(s.source).toBe("relay_read");
      expect(s.positions.map((p) => p.marketId)).toEqual(["aster:-:BTCUSDT"]);
      // the checks still run before anything is sent
      expect(await code(ingestSignedRead({ venue: "aster", mode: "relay", signedRead: await signedRead("positionRisk", { signer: stranger }) }, deps({ http })))).toBe("UNAUTHORIZED");
      expect(seen.length).toBe(1);
    } finally {
      server.stop();
    }
  });
});
