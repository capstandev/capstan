// Stand-in venues for the fork stack (ops/fork/up.sh). Venue execution cannot be forked, so the apps point at these
// local servers through CAPSTAN_VENUE_URL_<VENUE> (loopback only). Market data comes from the recorded fixtures the
// adapter tests use; account state is kept in memory: the Hyperliquid stand-in recovers the signer of every
// /exchange post exactly as the venue does (user-signed EIP-712 for approvals, the L1 phantom agent for orders) and
// refuses orders from an agent nobody approved. GET /__state and POST /__control let the scenario runner read what
// the venue saw and force a failure (S9 forces the Lighter-RH leg to fail).
// Usage: bun ops/fork/fake-venues.ts [--hl 22420] [--lighter-rh 22421] [--lighter 22422]
import { l1Digest, recoverSigner, userSignedDigest, type HlL1Action, type HlNetwork, type HlUserAction } from "@capstan/signer-hl";
import type { FakeHandler } from "@capstan/venue-client";
import { fx, route, USER_A } from "../../packages/adapters/hyperliquid/test/helpers";
import { fxRecord, type FxVenue } from "../../packages/adapters/lighter/test/helpers";

type Hex = `0x${string}`;

export interface HlState {
  network: HlNetwork;
  agents: Map<string, { address: string; name: string; validUntil: number }[]>; // owner -> agents
  agentOwner: Map<string, string>; // agent -> owner
  builderFee: Map<string, number>; // owner:builder -> tenths of a bp
  positions: Map<string, Map<string, number>>; // owner -> coin -> signed size
  orders: Map<number, { owner: string; coin: string; side: "B" | "A"; px: string; sz: string; filled: string; status: "open" | "filled" | "canceled" | "rejected"; cloid?: string; builder?: { b: string; f: number } }>;
  exchangePosts: { action: Record<string, unknown>; signer: string | null; at: number }[];
  nextOid: number;
  failOrders: number;
}

export function hlState(network: HlNetwork = "Mainnet"): HlState {
  return { network, agents: new Map(), agentOwner: new Map(), builderFee: new Map(), positions: new Map(), orders: new Map(), exchangePosts: [], nextOid: 9_000_000, failOrders: 0 };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
const lower = (s: unknown) => String(s ?? "").toLowerCase();
const ok = (data: unknown) => Response.json({ status: "ok", response: data });
const err = (msg: string) => Response.json({ status: "err", response: msg });

/** The coin name of an asset id from the recorded universes (core perps 0.., HIP-3 dex d at 100000 + d*10000 + i). */
function coinOf(a: number): string {
  if (a < 100_000) return String((fx<{ universe: { name: string }[] }>("meta").universe[a] ?? { name: `#${a}` }).name);
  const dexIdx = Math.floor((a - 100_000) / 10_000);
  const i = (a - 100_000) % 10_000;
  const dexes = fx<({ name: string } | null)[]>("perpDexs");
  const dex = dexes[dexIdx]?.name;
  if (!dex) return `#${a}`;
  try {
    const m = fx<[{ universe: { name: string }[] }]>(`metaAndAssetCtxs_${dex}`)[0];
    return m.universe[i]?.name ?? `${dex}:#${i}`;
  } catch {
    return `${dex}:#${i}`;
  }
}

function chs(st: HlState, owner: string) {
  const pos = st.positions.get(owner) ?? new Map();
  const assetPositions = [...pos.entries()].filter(([, s]) => s !== 0).map(([coin, szi]) => ({ type: "oneWay", position: { coin, szi: String(szi), entryPx: "100.0", positionValue: String(Math.abs(szi) * 100), unrealizedPnl: "0.0", returnOnEquity: "0.0", liquidationPx: null, marginUsed: "10.0", leverage: { type: "cross", value: 5 }, maxLeverage: 20, cumFunding: { allTime: "0.0", sinceOpen: "0.0", sinceChange: "0.0" } } }));
  const sum = { accountValue: "10000.0", totalNtlPos: "0.0", totalRawUsd: "10000.0", totalMarginUsed: "0.0" };
  return { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: "0.0", withdrawable: "10000.0", assetPositions, time: Date.now() };
}

export function hlRoutes(st: HlState): Record<string, FakeHandler> {
  return {
    "POST /info": async (r) => {
      const b = (await r.json()) as Record<string, any>;
      const user = lower(b.user);
      const known = user && user !== USER_A;
      switch (b.type) {
        case "extraAgents":
          if (known) return Response.json(st.agents.get(user) ?? []);
          break;
        case "maxBuilderFee":
          if (known) return Response.json(st.builderFee.get(`${user}:${lower(b.builder)}`) ?? 0);
          break;
        case "approvedBuilders":
          if (known) return Response.json([...st.builderFee.keys()].filter((k) => k.startsWith(`${user}:`)).map((k) => k.split(":")[1]));
          break;
        case "clearinghouseState":
          if (known) return Response.json(chs(st, user));
          break;
        case "openOrders":
        case "frontendOpenOrders":
          if (known) return Response.json([...st.orders.entries()].filter(([, o]) => o.owner === user && o.status === "open").map(([oid, o]) => ({ coin: o.coin, side: o.side, limitPx: o.px, sz: o.sz, oid, timestamp: Date.now(), origSz: o.sz, ...(o.cloid ? { cloid: o.cloid } : {}) })));
          break;
        case "orderStatus": {
          const o = st.orders.get(Number(b.oid));
          if (!o) return Response.json({ status: "unknownOid" });
          // like the venue: sz is what remains, origSz what was asked
          const remaining = Math.max(0, Number(o.sz) - Number(o.filled));
          return Response.json({ status: "order", order: { order: { coin: o.coin, side: o.side, limitPx: o.px, sz: String(remaining), oid: Number(b.oid), origSz: o.sz }, status: o.status, statusTimestamp: Date.now() } });
        }
        case "allMids":
          return Response.json({ BTC: "76154.5", ETH: "2500.0", "xyz:TSLA": "347.65" });
        case "userFees":
          return Response.json({ userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0.0" });
        case "userFills":
        case "userFillsByTime":
          if (known) return Response.json([]);
          break;
      }
      const out = route(b) as Record<string, unknown>;
      // recorded books carry their capture time; a live venue's book is always fresh
      if (b.type === "l2Book" && out && typeof out === "object") {
        // BTC: a thinner book than the Lighter-RH stand-in's, so a BTC spread legs Hyperliquid first (S9)
        if (b.coin === "BTC") {
          const lvl = (px: number) => ({ px: px.toFixed(1), sz: "0.05", n: 1 });
          return Response.json({ coin: "BTC", time: Date.now(), levels: [Array.from({ length: 10 }, (_, i) => lvl(76154 - i)), Array.from({ length: 10 }, (_, i) => lvl(76155 + i))] });
        }
        return Response.json({ ...out, time: Date.now() });
      }
      return Response.json(out);
    },
    "POST /exchange": async (r) => {
      const body = (await r.json()) as { action: Record<string, any>; nonce: number; signature: { r: Hex; s: Hex; v: number }; vaultAddress?: Hex | null; expiresAfter?: number | null };
      const a = body.action;
      let signer: string | null = null;
      try {
        if (a.type === "approveAgent" || a.type === "approveBuilderFee") {
          const ua = { ...a, agentName: a.type === "approveAgent" ? (a.agentName ?? "") : undefined, nonce: body.nonce } as unknown as HlUserAction;
          signer = lower(recoverSigner(userSignedDigest(ua), body.signature));
        } else {
          signer = lower(recoverSigner(l1Digest(a as unknown as HlL1Action, body.vaultAddress ?? null, body.nonce, st.network, body.expiresAfter ?? undefined), body.signature));
        }
      } catch (e) {
        return err(`invalid signature: ${(e as Error).message}`);
      }
      st.exchangePosts.push({ action: a, signer, at: Date.now() });
      if (a.type === "approveAgent") {
        const [name, until] = String(a.agentName ?? "").split(" valid_until ");
        const list = (st.agents.get(signer) ?? []).filter((x) => x.address !== lower(a.agentAddress));
        list.push({ address: lower(a.agentAddress), name: name ?? "", validUntil: Number(until ?? Date.now() + 86_400_000) });
        st.agents.set(signer, list);
        st.agentOwner.set(lower(a.agentAddress), signer);
        return ok({ type: "default" });
      }
      if (a.type === "approveBuilderFee") {
        st.builderFee.set(`${signer}:${lower(a.builder)}`, Math.round(Number(String(a.maxFeeRate).replace("%", "")) * 1000));
        return ok({ type: "default" });
      }
      const owner = st.agentOwner.get(signer);
      if (!owner) return err(`User or API Wallet ${signer} does not exist.`);
      if (a.type === "order") {
        if (st.failOrders > 0) {
          st.failOrders--;
          return ok({ type: "order", data: { statuses: (a.orders as unknown[]).map(() => ({ error: "Order could not immediately match against any resting orders." })) } });
        }
        if (a.builder) {
          const max = st.builderFee.get(`${owner}:${lower(a.builder.b)}`) ?? 0;
          if (Number(a.builder.f) > max) return err("Builder fee has not been approved.");
        }
        const statuses = (a.orders as { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif: string } }; c?: string }[]).map((o) => {
          const oid = st.nextOid++;
          const coin = coinOf(o.a);
          const ioc = o.t.limit?.tif === "Ioc";
          st.orders.set(oid, { owner, coin, side: o.b ? "B" : "A", px: o.p, sz: o.s, filled: ioc ? o.s : "0", status: ioc ? "filled" : "open", ...(o.c ? { cloid: o.c } : {}), ...(a.builder ? { builder: a.builder } : {}) });
          if (ioc) {
            const pos = st.positions.get(owner) ?? new Map<string, number>();
            pos.set(coin, (pos.get(coin) ?? 0) + (o.b ? 1 : -1) * Number(o.s));
            st.positions.set(owner, pos);
            return { filled: { totalSz: o.s, avgPx: o.p, oid } };
          }
          return { resting: { oid } };
        });
        return ok({ type: "order", data: { statuses } });
      }
      if (a.type === "cancel" || a.type === "cancelByCloid") {
        const list = (a.cancels ?? []) as { o?: number; oid?: number; cloid?: string }[];
        const statuses = list.map((c) => {
          const oid = c.o ?? c.oid;
          const hit = oid !== undefined ? st.orders.get(Number(oid)) : [...st.orders.values()].find((x) => x.cloid === c.cloid);
          if (!hit || hit.status !== "open") return { error: "Order was never placed, already canceled, or filled." };
          hit.status = "canceled";
          return "success";
        });
        return ok({ type: "cancel", data: { statuses } });
      }
      return ok({ type: "default" });
    },
  };
}

/** Lighter stand-in: the recorded market data of one config; every transaction is refused while failTx is on. */
export function lighterRoutes(venue: FxVenue, ctl: { failTx: boolean; sent: unknown[] }): Record<string, FakeHandler> {
  const serve = (name: string) => {
    const rec = fxRecord(venue, name);
    return new Response(typeof rec.response === "string" ? rec.response : JSON.stringify(rec.response), { status: rec.status, headers: { "content-type": "application/json" } });
  };
  const names = ["root", "info", "orderBooks", "orderBookDetails", "fundings", "feeTiers", "systemConfig", "account", "apikeys", "nextNonce", "orderBookOrders"];
  const routes: Record<string, FakeHandler> = Object.fromEntries(names.map((n) => [n === "root" ? "GET /" : `GET /${n === "info" ? "info" : `api/v1/${n}`}`, () => serve(n)]));
  routes["GET /api/v1/accountsByL1Address"] = () => serve("accountsByL1Address_none");
  // recorded funding points moved up to the current hour (a live venue's last point is at most an hour old)
  routes["GET /api/v1/fundings"] = () => {
    const rec = fxRecord(venue, "fundings").response as { fundings?: { timestamp: number }[] };
    const pts = rec.fundings ?? [];
    const last = Math.max(0, ...pts.map((p) => p.timestamp));
    const shift = Math.floor(Date.now() / 3_600_000) * 3600 - last;
    return Response.json({ ...rec, fundings: pts.map((p) => ({ ...p, timestamp: p.timestamp + shift })) });
  };
  // the recorded book is market 0 (ETH); other markets get a synthetic book around a recorded-day mid, fresh each read
  const MIDS: Record<string, number> = { "1": 76152.0 };
  routes["GET /api/v1/orderBookOrders"] = (r) => {
    const id = new URL(r.url).searchParams.get("market_id") ?? "0";
    const mid = MIDS[id];
    if (mid === undefined) return serve("orderBookOrders");
    const lvl = (side: 1 | -1, i: number) => ({ order_index: 1000 + i, order_id: String(1000 + i), owner_account_index: 1, initial_base_amount: "0.50000", remaining_base_amount: "0.50000", price: (mid + side * (1 + i) * 0.5).toFixed(1), order_expiry: Date.now() + 86_400_000, transaction_time: 0 });
    return Response.json({ code: 200, total_asks: 10, asks: Array.from({ length: 10 }, (_, i) => lvl(1, i)), total_bids: 10, bids: Array.from({ length: 10 }, (_, i) => lvl(-1, i)) });
  };
  const send: FakeHandler = async (r) => {
    ctl.sent.push(await r.text());
    if (ctl.failTx) return Response.json({ code: 21_120, message: "order rejected by the venue (forced failure on the fork stack)" }, { status: 400 });
    return Response.json({ code: 200, tx_hash: `0x${"ab".repeat(32)}` });
  };
  routes["POST /api/v1/sendTx"] = send;
  routes["POST /api/v1/sendTxBatch"] = send;
  return routes;
}

export function startFakeVenues(ports: { hl: number; lighterRh: number; lighter: number }, network: HlNetwork = "Mainnet") {
  const hl = hlState(network);
  const rh = { failTx: false, sent: [] as unknown[] };
  const lm = { failTx: false, sent: [] as unknown[] };
  const serve = (port: number, routes: Record<string, FakeHandler>, name: string) => {
    const answer = (req: Request) => answerFor(req, routes, name);
    return Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req) {
        // the dashboard's SDK reads the venue from the browser, so the stand-in answers CORS like a public venue API
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        const res = await answer(req);
        for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
        return res;
      },
    });
  };
  async function answerFor(req: Request, routes: Record<string, FakeHandler>, name: string): Promise<Response> {
        const u = new URL(req.url);
        if (u.pathname === "/__state") return Response.json(name === "hl" ? { orders: Object.fromEntries(hl.orders), agents: Object.fromEntries(hl.agents), builderFee: Object.fromEntries(hl.builderFee), posts: hl.exchangePosts.length, failOrders: hl.failOrders } : { failTx: (name === "rh" ? rh : lm).failTx, sent: (name === "rh" ? rh : lm).sent.length });
        if (u.pathname === "/__control" && req.method === "POST") {
          const c = (await req.json()) as { failOrders?: number; failTx?: boolean };
          if (name === "hl" && typeof c.failOrders === "number") hl.failOrders = c.failOrders;
          if (name !== "hl" && typeof c.failTx === "boolean") (name === "rh" ? rh : lm).failTx = c.failTx;
          return Response.json({ ok: true });
        }
        const h = routes[`${req.method} ${u.pathname}`] ?? routes[u.pathname];
        if (!h) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
        return h(req);
  }
  const s = [serve(ports.hl, hlRoutes(hl), "hl"), serve(ports.lighterRh, lighterRoutes("lighter-466324", rh), "rh"), serve(ports.lighter, lighterRoutes("lighter-304", lm), "lighter")];
  return { hl, rh, lm, urls: s.map((x) => `http://127.0.0.1:${x.port}`), stop: () => s.forEach((x) => x.stop(true)) };
}

if (import.meta.main) {
  const arg = (k: string, d: number) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? Number(process.argv[i + 1]) : d;
  };
  const v = startFakeVenues({ hl: arg("--hl", 22420), lighterRh: arg("--lighter-rh", 22421), lighter: arg("--lighter", 22422) });
  console.log(`fake-venues: hyperliquid ${v.urls[0]}, lighter-rh ${v.urls[1]}, lighter ${v.urls[2]}`);
  const stop = () => (v.stop(), process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
