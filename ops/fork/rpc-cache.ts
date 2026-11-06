// A caching JSON-RPC proxy in front of a public RPC, for anvil --fork-url (ops/fork/up.sh). The free Robinhood Chain
// RPC keeps only about 10 minutes of state and answers 429 under load, so state reads at a fixed block are cached
// (eth_call, eth_getCode, eth_getStorageAt, eth_getBalance, eth_getTransactionCount at a block number or hash, plus
// eth_chainId and blocks by number), everything else read-only passes through, and a 429 or 5xx is retried with
// backoff. Writes are refused (R4): eth_sendRawTransaction and friends never reach the real chain; transactions go
// to the local anvil only. The public RPC also drops state older than about 10 minutes, so a fork session that runs
// longer would fail on the first account anvil had not read yet (every fresh test wallet). A fixed-block state read
// that the upstream refuses with "historical state ... is not available" is retried at the upstream's latest block
// and counted in /health as staleFallbacks: a fresh account is empty at either block, and a contract slot read late
// is at most the newest value. Usage: bun ops/fork/rpc-cache.ts [--port 22446] [--upstream https://...]
const REFUSED = /^(eth_send|eth_sign|personal_|anvil_|hardhat_|evm_|debug_|admin_|miner_|txpool_|wallet_)/;
const AT_BLOCK = new Map<string, number>([
  ["eth_call", 1],
  ["eth_getCode", 1],
  ["eth_getStorageAt", 2],
  ["eth_getBalance", 1],
  ["eth_getTransactionCount", 1],
  ["eth_getProof", 2],
]);
const ALWAYS = new Set(["eth_chainId", "net_version"]);
const HISTORY_GONE = /historical state .* is not available|missing trie node|header not found/i;

/** The same request at the latest block. */
export function withLatest(r: Rpc): unknown[] {
  const p = [...(Array.isArray(r.params) ? r.params : [])];
  const at = r.method === "eth_feeHistory" ? 1 : AT_BLOCK.get(r.method ?? "");
  if (at !== undefined) p[at] = "latest";
  return p;
}

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };
type RpcOut = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

export interface RpcCacheOptions {
  upstream: string;
  port?: number;
  /** Retries on 429 or 5xx (default 6), first delay in ms (default 250, doubled each time, capped at 8 s). */
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** The cache key of a request, or null when the answer may change (latest, pending, safe, a missing block). */
export function cacheKey(r: Rpc): string | null {
  const m = r.method ?? "";
  const p = Array.isArray(r.params) ? r.params : [];
  if (ALWAYS.has(m)) return m;
  if (m === "eth_getBlockByNumber" && typeof p[0] === "string" && /^0x[0-9a-f]+$/i.test(p[0])) return `${m}:${JSON.stringify(p)}`;
  if (m === "eth_getBlockByHash" || m === "eth_getTransactionReceipt" || m === "eth_getTransactionByHash") return null;
  const at = AT_BLOCK.get(m);
  if (at === undefined) return null;
  const tag = p[at];
  const fixed = (typeof tag === "string" && /^0x[0-9a-f]+$/i.test(tag)) || (tag !== null && typeof tag === "object" && ("blockHash" in (tag as object) || "blockNumber" in (tag as object)));
  return fixed ? `${m}:${JSON.stringify(p)}` : null;
}

export function refused(method: string | undefined): boolean {
  return REFUSED.test(method ?? "");
}

export function startRpcCache(o: RpcCacheOptions) {
  const cache = new Map<string, unknown>();
  const stats = { hits: 0, misses: 0, passed: 0, refused: 0, retried: 0, upstreamCalls: 0, staleFallbacks: 0 };
  const f = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => {});
  const retries = o.retries ?? 6;
  const first = o.backoffMs ?? 250;

  async function upstream(body: Rpc[]): Promise<RpcOut[]> {
    let delay = first;
    for (let attempt = 0; ; attempt++) {
      stats.upstreamCalls++;
      let r: Response | null = null;
      try {
        r = await f(o.upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.length === 1 ? body[0] : body) });
      } catch (e) {
        if (attempt >= retries) throw e;
      }
      if (r && r.status !== 429 && r.status < 500) {
        const j = (await r.json()) as RpcOut | RpcOut[];
        return Array.isArray(j) ? j : [j];
      }
      if (attempt >= retries) throw new Error(`upstream answered ${r?.status ?? "no response"} after ${attempt + 1} tries`);
      stats.retried++;
      log(`upstream ${r?.status ?? "error"}, retry in ${delay} ms`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 8_000);
    }
  }

  async function handle(reqs: Rpc[]): Promise<RpcOut[]> {
    const out: (RpcOut | null)[] = reqs.map(() => null);
    const pending: { i: number; r: Rpc; key: string | null }[] = [];
    reqs.forEach((r, i) => {
      if (refused(r.method)) {
        stats.refused++;
        out[i] = { jsonrpc: "2.0", id: r.id ?? null, error: { code: -32601, message: `rpc-cache refuses ${r.method}: writes go to the local anvil only, never to the real chain` } };
        return;
      }
      const key = cacheKey(r);
      if (key && cache.has(key)) {
        stats.hits++;
        out[i] = { jsonrpc: "2.0", id: r.id ?? null, result: cache.get(key) };
        return;
      }
      pending.push({ i, r, key });
    });
    if (pending.length) {
      const sent = pending.map((p, n) => ({ jsonrpc: "2.0", id: n, method: p.r.method, params: p.r.params ?? [] }));
      const got = await upstream(sent);
      const byId = new Map(got.map((g) => [Number(g.id), g]));
      // pruned history: read the same thing at the newest block instead (see the header)
      const stale = pending.map((p, n) => ({ p, n, g: byId.get(n) })).filter((x) => x.g?.error && HISTORY_GONE.test(x.g.error.message) && (AT_BLOCK.has(x.p.r.method ?? "") || x.p.r.method === "eth_feeHistory"));
      if (stale.length) {
        const again = await upstream(stale.map((x) => ({ jsonrpc: "2.0", id: x.n, method: x.p.r.method, params: withLatest(x.p.r) })));
        for (const g of again) {
          if (g.error === undefined) {
            byId.set(Number(g.id), g);
            stats.staleFallbacks++;
          }
        }
        log(`history pruned upstream: ${stale.length} read(s) answered at latest`);
      }
      pending.forEach((p, n) => {
        const g = byId.get(n) ?? { jsonrpc: "2.0" as const, id: n, error: { code: -32603, message: "no answer from upstream" } };
        if (p.key && g.error === undefined) {
          cache.set(p.key, g.result);
          stats.misses++;
        } else stats.passed++;
        out[p.i] = { ...g, jsonrpc: "2.0", id: p.r.id ?? null };
      });
    }
    return out as RpcOut[];
  }

  const server = Bun.serve({
    port: o.port ?? 22446,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname === "/health") return Response.json({ ok: true, entries: cache.size, ...stats });
      if (req.method !== "POST") return new Response("POST JSON-RPC only", { status: 405 });
      let body: Rpc | Rpc[];
      try {
        body = (await req.json()) as Rpc | Rpc[];
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
      }
      try {
        const out = await handle(Array.isArray(body) ? body : [body]);
        return Response.json(Array.isArray(body) ? out : out[0]);
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", id: Array.isArray(body) ? null : (body.id ?? null), error: { code: -32603, message: `upstream failed: ${(e as Error).message}` } }, { status: 502 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port, stats, cache, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const upstream = arg("--upstream") ?? process.env.RPC_UPSTREAM ?? "https://rpc.mainnet.chain.robinhood.com";
  if (!/^https?:\/\//.test(upstream)) throw new Error("upstream must be an http(s) URL");
  const s = startRpcCache({ upstream, port: Number(arg("--port") ?? process.env.RPC_CACHE_PORT ?? 22446), log: (l) => console.log(`rpc-cache: ${l}`) });
  console.log(`rpc-cache: listening ${s.url} -> ${new URL(upstream).host} (writes refused)`);
  const stop = () => (s.stop(), process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
