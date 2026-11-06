// R4: the fork's caching proxy never forwards a write to the real RPC; it caches reads at a fixed block, passes
// moving reads through, and backs off on 429.
import { afterAll, describe, expect, test } from "bun:test";
import { cacheKey, startRpcCache } from "../rpc-cache";

function fakeUpstream(o: { fail429?: number; pruned?: boolean } = {}) {
  const seen: { method: string; params: unknown }[] = [];
  let left429 = o.fail429 ?? 0;
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (left429 > 0) return (left429--, new Response("slow down", { status: 429 }));
      const b = (await req.json()) as { id: number; method: string; params: unknown } | { id: number; method: string; params: unknown }[];
      const arr = Array.isArray(b) ? b : [b];
      for (const r of arr) seen.push({ method: r.method, params: r.params });
      const gone = (r: { params: unknown }) => o.pruned && Array.isArray(r.params) && r.params.some((x) => x === "0x10");
      const out = arr.map((r) => gone(r) ? { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "historical state 671e is not available" } } : ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? "0x1237" : `${r.method}-${seen.length}` }));
      return Response.json(Array.isArray(b) ? out : out[0]);
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, seen, stop: () => srv.stop(true) };
}

const rpc = async (url: string, body: unknown) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

describe("rpc-cache", () => {
  test("no-real-writes", async () => {
    const up = fakeUpstream();
    const c = startRpcCache({ upstream: up.url, port: 0 });
    stops.push(up.stop, c.stop);
    for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_signTypedData_v4", "personal_sign", "anvil_setBalance", "evm_increaseTime", "debug_traceCall"]) {
      const r = await rpc(c.url, { jsonrpc: "2.0", id: 7, method: m, params: ["0x02f8"] });
      expect(r.id).toBe(7);
      expect(r.error.code).toBe(-32601);
      expect(r.error.message).toContain("refuses");
    }
    // a write hidden in a batch is refused too; the read next to it still goes through
    const batch = await rpc(c.url, [{ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x02"] }, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }]);
    expect(batch[0].error.code).toBe(-32601);
    expect(batch[1].result).toBeDefined();
    expect(up.seen.map((s) => s.method)).toEqual(["eth_blockNumber"]);
    expect(c.stats.refused).toBe(8);
  });

  test("caches-by-block", async () => {
    const up = fakeUpstream();
    const c = startRpcCache({ upstream: up.url, port: 0 });
    stops.push(up.stop, c.stop);
    const at = { jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: ["0xabc", "0x0", "0x10"] };
    const a = await rpc(c.url, at);
    const b = await rpc(c.url, { ...at, id: 2 });
    expect(b.result).toBe(a.result);
    expect(b.id).toBe(2);
    await rpc(c.url, { jsonrpc: "2.0", id: 3, method: "eth_getStorageAt", params: ["0xabc", "0x0", "latest"] });
    await rpc(c.url, { jsonrpc: "2.0", id: 4, method: "eth_getStorageAt", params: ["0xabc", "0x0", "latest"] });
    expect(up.seen.filter((s) => s.method === "eth_getStorageAt").length).toBe(3); // one fixed-block read, two latest
    expect(cacheKey({ method: "eth_call", params: [{}, "pending"] })).toBeNull();
    expect(cacheKey({ method: "eth_call", params: [{}, { blockHash: "0x01" }] })).not.toBeNull();
  });

  test("pruned-history-read-at-latest", async () => {
    const up = fakeUpstream({ pruned: true });
    const c = startRpcCache({ upstream: up.url, port: 0 });
    stops.push(up.stop, c.stop);
    const r = await rpc(c.url, { jsonrpc: "2.0", id: 5, method: "eth_getBalance", params: ["0xabc", "0x10"] });
    expect(r.error).toBeUndefined();
    expect(r.id).toBe(5);
    expect(up.seen.map((s) => (s.params as unknown[])[1])).toEqual(["0x10", "latest"]);
    expect(c.stats.staleFallbacks).toBe(1);
    // fee history over pruned blocks (forge's EIP-1559 estimate) is read up to the newest block instead
    const fh = await rpc(c.url, { jsonrpc: "2.0", id: 8, method: "eth_feeHistory", params: ["0xa", "0x10", [50]] });
    expect(fh.error).toBeUndefined();
    expect(c.stats.staleFallbacks).toBe(2);
    // a write is still refused, and a non-state method's error passes through unchanged
    expect((await rpc(c.url, { jsonrpc: "2.0", id: 6, method: "eth_sendRawTransaction", params: ["0x10"] })).error.code).toBe(-32601);
  });

  test("backoff-on-429", async () => {
    const up = fakeUpstream({ fail429: 2 });
    const c = startRpcCache({ upstream: up.url, port: 0, backoffMs: 5 });
    stops.push(up.stop, c.stop);
    const r = await rpc(c.url, { jsonrpc: "2.0", id: 9, method: "eth_chainId", params: [] });
    expect(r.result).toBe("0x1237");
    expect(c.stats.retried).toBe(2);
  });
});
