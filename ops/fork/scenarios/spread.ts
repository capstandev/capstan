// S9: a spread plan on the Hyperliquid and Lighter-RH stand-ins through the real api (plan, owner ack, events) and the
// SDK's client-side executor, with hedgeFailurePolicy flatten_leg_a and leg B forced to fail; the plan ends
// 'flattened' with a receipt per sent leg. The ingest jobs fill the market-data cache from venue streams the
// stand-ins do not serve, so the runner writes the same cache entries from the adapters' own reads, every 250 ms, while the scenario runs.
import { proposeEquivalence, reviewEquivalence, setExecutable } from "@capstan/catalog";
import { createMarketDataCache, createRedis } from "@capstan/core";
import { createHlReader, HL_MAINNET } from "@capstan/adapter-hyperliquid";
import { lighterConfigsFor, lighterReaderFor } from "@capstan/adapter-lighter";
import { executeSpreadPlan, spreadAckMessage } from "@capstan/sdk";
import { db as schema, type Hex } from "@capstan/schema";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { eq } from "drizzle-orm";
import { PORTS, REDIS_URL, type Row } from "../lib";
import type { Ctx } from "../every-tx";
import { agentSigHeaders, api, BTC, ensureMarkets, onboardUser, type User } from "./money";

const RH_BTC = "lighter-rh:-:BTC";

/** Keep the cache fresh the way the ingest does (books live 1 s): re-read both markets every 250 ms until stopped. */
function feedCache(): { stop(): Promise<void> } {
  const redis = createRedis(REDIS_URL);
  const cache = createMarketDataCache(redis);
  const gov = createMemoryGovernor("fork");
  const hlCfg = { ...HL_MAINNET, infoUrl: `http://127.0.0.1:${PORTS.hl}/info`, exchangeUrl: `http://127.0.0.1:${PORTS.hl}/exchange`, builderAddress: null };
  const hl = createHlReader(hlCfg as never, venueHttp("hyperliquid", `http://127.0.0.1:${PORTS.hl}`, gov), cache);
  const rh = lighterReaderFor(lighterConfigsFor(process.env)[1], gov, cache, { rest: `http://127.0.0.1:${PORTS.lighterRh}` });
  let on = true;
  // venue reads every 3 s (the Lighter budget allows about 1 request a second), cache writes every 200 ms with the
  // book stamped at write time, as a streaming ingest would keep it; the stand-in books do not move anyway
  const last = new Map<string, { book: Awaited<ReturnType<typeof hl.getBook>>; funding: Awaited<ReturnType<typeof hl.getFunding>> }>();
  const read = async () => {
    for (const [r, id] of [[hl, BTC], [rh, RH_BTC]] as const) last.set(id, { book: await r.getBook(id, 20), funding: await r.getFunding(id) });
  };
  const reader = (async () => {
    while (on) {
      await read().catch(() => undefined);
      for (let i = 0; i < 15 && on; i++) await Bun.sleep(200);
    }
  })();
  const loop = (async () => {
    while (on) {
      for (const v of last.values()) {
        await cache.putBook({ ...v.book, asOf: new Date().toISOString() }).catch(() => undefined);
        await cache.putFunding(v.funding).catch(() => undefined);
      }
      await Bun.sleep(200);
    }
    await reader;
  })();
  return {
    async stop() {
      on = false;
      await loop;
      await redis.quit();
    },
  };
}

export async function s9(ctx: Ctx): Promise<Row[]> {
  const rows: Row[] = [];
  await ensureMarkets(ctx);
  const { runCatalogSync } = await import("../../../apps/workers/src/jobs/catalog-sync.job");
  const { source } = await import("../../../apps/workers/src/jobs/catalog-sources/lighter-rh.source");
  await runCatalogSync(ctx.jobDeps(), [source]);
  const [m] = await ctx.db.select({ executable: schema.markets.executable }).from(schema.markets).where(eq(schema.markets.id, RH_BTC)).limit(1);
  if (m && !m.executable) await setExecutable(ctx.db, RH_BTC, true, "fork-run", "fork stack: Lighter-RH BTC leg for the spread scenario");
  let eqId = ctx.shared.eqId as string | undefined;
  if (!eqId) {
    eqId = await proposeEquivalence(ctx.db, "CR:BTC", [BTC, RH_BTC], "fork stack: BTC on Hyperliquid and Lighter-RH");
    await reviewEquivalence(ctx.db, eqId, "approved", "fork-run", "fork stack review of the BTC pair", { overrideReason: "fork stand-in markets" });
    ctx.shared.eqId = eqId;
  }
  const u: User = await onboardUser(ctx);
  const feed = feedCache();
  await Bun.sleep(4_000);
  try {
  const owner = u.wallet.address.toLowerCase() as Hex;
  const body = { owner, equivalenceId: eqId, sizeBase: "0.002", leverage: 1, hedgeFailurePolicy: "flatten_leg_a", marketIds: [BTC, RH_BTC] };
  const pl = await api<{ planId: string; status: string; legA: { venue: string; marketId: string }; legB: { venue: string; marketId: string }; error?: { code: string; message: string } }>("POST", "/spreads/plan", body, await agentSigHeaders(u.keystore, u.client, u.agentRef, "POST", "/v1/spreads/plan", body));
  rows.push({ id: "S9", scenario: "plan a BTC spread (Hyperliquid and Lighter-RH), flatten_leg_a", ref: "POST /v1/spreads/plan", gas: "-", result: pl.status === 200 ? "pass" : "fail", receipt: "-", check: pl.status === 200 ? `plan ${pl.body.planId}: leg A ${pl.body.legA.marketId}, leg B ${pl.body.legB.marketId}` : `${pl.status} ${JSON.stringify(pl.body).slice(0, 200)}` });
  if (pl.status !== 200) return rows;
  const planId = pl.body.planId;
  const issuedAt = Date.now();
  const message = spreadAckMessage({ planId, owner, host: `127.0.0.1:${PORTS.api}`, chainId: 4663, nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex"), issuedAt });
  const ackBody = { sig: await u.wallet.signMessage({ message }), message, by: owner };
  const ack = await api<{ status: string }>("POST", `/spreads/${planId}/ack`, ackBody, await agentSigHeaders(u.keystore, u.client, u.agentRef, "POST", `/v1/spreads/${planId}/ack`, ackBody));
  rows.push({ id: "S9", scenario: "owner acknowledges the at-risk plan", ref: `POST /v1/spreads/${planId}/ack`, gas: "-", result: ack.status === 200 ? "pass" : "fail", receipt: "-", check: `${ack.status} ${JSON.stringify(ack.body).slice(0, 120)}` });
  // leg B is forced to fail at the Lighter-RH stand-in; leg A fills on the Hyperliquid stand-in (IOC)
  await fetch(`http://127.0.0.1:${PORTS.lighterRh}/__control`, { method: "POST", body: JSON.stringify({ failTx: true }) });
  const legBIsHl = pl.body.legB.venue === "hyperliquid";
  if (legBIsHl) await fetch(`http://127.0.0.1:${PORTS.hl}/__control`, { method: "POST", body: JSON.stringify({ failOrders: 1 }) });
  const signedApi = {
    get: async <T>(path: string) => (await api<T>("GET", path, undefined, await agentSigHeaders(u.keystore, u.client, u.agentRef, "GET", `/v1${path}`, undefined))).body,
    post: async <T>(path: string, b: unknown) => (await api<T>("POST", path, b, await agentSigHeaders(u.keystore, u.client, u.agentRef, "POST", `/v1${path}`, b))).body,
  };
  const fillOf = async (_v: string, oid: string) => {
    const st = (await (await fetch(`http://127.0.0.1:${PORTS.hl}/__state`)).json()) as { orders: Record<string, { filled: string; px: string; status: string }> };
    const o = st.orders[oid];
    return { filled: o?.filled ?? "0", avgPx: o?.px ?? null, done: o ? o.status !== "open" : true };
  };
  let res;
  try {
    res = await executeSpreadPlan(planId, u.client, signedApi as never, { fillOf, sleep: (ms) => Bun.sleep(Math.min(ms, 50)) });
  } finally {
    await fetch(`http://127.0.0.1:${PORTS.lighterRh}/__control`, { method: "POST", body: JSON.stringify({ failTx: false }) });
    await fetch(`http://127.0.0.1:${PORTS.hl}/__control`, { method: "POST", body: JSON.stringify({ failOrders: 0 }) });
  }
  const view = await signedApi.get<{ plan: { status: string }; events?: { kind: string; data?: unknown }[] }>(`/spreads/${planId}`);
  const events = view.events ?? [];
  rows.push({ id: "S9", scenario: "executor: leg A filled, leg B failed, leg A flattened (reduce-only IOC)", ref: `plan ${planId}`, gas: "-", result: res.status === "flattened" && view.plan?.status === "flattened" ? "pass" : "fail", receipt: "-", check: `executor ${res.status}, server ${view.plan?.status}; events ${events.map((e) => e.kind).join(", ")}; leg A filled ${res.legAFilled}, leg B ${res.legBFilled}` });
  const mine = await signedApi.get<{ receipts: { receiptId: string; action: string; requestHash?: string }[] } | { receiptId: string; action: string }[]>(`/receipts?owner=${owner}&limit=50`);
  const list = (Array.isArray(mine) ? mine : mine.receipts ?? []) as { receiptId: string; action: string }[];
  const legs = list.filter((r) => r.action === "spread.leg");
  const plans = list.filter((r) => r.action === "spread.plan");
  const verified = events.find((e) => e.kind === "leg_a_filled") as { data?: { mismatch?: boolean | null } } | undefined;
  rows.push({ id: "S9", scenario: "receipts: a spread.leg per filled leg, a spread.plan at the end; the leg fill matches the venue read", ref: `GET /v1/receipts`, gas: "-", result: legs.length >= 1 && plans.length === 1 && verified?.data?.mismatch === false ? "pass" : "fail", receipt: [...legs, ...plans].map((r) => r.receiptId).slice(0, 3).join(" "), check: `${legs.length} spread.leg, ${plans.length} spread.plan; leg A venue cross-check mismatch=${String(verified?.data?.mismatch)}` });
  return rows;
  } finally {
    await feed.stop();
  }
}
