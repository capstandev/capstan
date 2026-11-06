// The fork's front door (ops/fork/up.sh): every JSON-RPC call goes to the local anvil unchanged, except
// eth_maxPriorityFeePerGas and eth_fillTransaction, which answer what the real chain answers (Robinhood Chain 0, Base 0.001 gwei). anvil
// always suggests a 1 gwei tip, about 45 times the whole RHC gas price, so on a bare anvil every viem client sends
// 1 gwei tips and the x402 economics see settles 50 times dearer than they are. Only a loopback target is accepted.
// Usage: bun ops/fork/fee-shim.ts --port 22445 --target http://127.0.0.1:22449 --tip 0
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

export function startFeeShim(o: { port: number; target: string; tipWei: bigint }) {
  const t = new URL(o.target);
  if (!["127.0.0.1", "localhost"].includes(t.hostname)) throw new Error("fee-shim forwards to a local anvil only");
  const tip = `0x${o.tipWei.toString(16)}`;
  // eth_fillTransaction: anvil fills a 1 gwei tip; the real chains do not serve it (RHC answers -32601, checked
  // 2026-11-06), so viem falls back to its own estimate from eth_maxPriorityFeePerGas, as it does on the real chain
  const answer = (r: { id?: unknown; method?: string }) =>
    r.method === "eth_maxPriorityFeePerGas"
      ? { jsonrpc: "2.0", id: r.id ?? null, result: tip }
      : r.method === "eth_fillTransaction"
        ? { jsonrpc: "2.0", id: r.id ?? null, error: { code: -32601, message: "the method eth_fillTransaction does not exist/is not available" } }
        : null;
  const server = Bun.serve({
    port: o.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      // browsers (the dashboard's /verify, a wallet extension) call the RPC cross-origin, as they do anvil itself
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const res = await answer2(req);
      for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
      return res;
    },
  });
  async function answer2(req: Request): Promise<Response> {
      if (req.method !== "POST") return new Response("POST JSON-RPC only", { status: 405 });
      const text = await req.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
      }
      const list = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: string }[];
      const local = list.map(answer);
      if (local.every((x) => x !== null)) return Response.json(Array.isArray(body) ? local : local[0]);
      const rest = list.filter((_, i) => local[i] === null);
      const r = await fetch(o.target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array.isArray(body) ? rest : rest[0]) });
      const got = (await r.json()) as unknown;
      if (!Array.isArray(body)) return Response.json(got, { status: r.status });
      const g = got as unknown[];
      let k = 0;
      return Response.json(local.map((x) => x ?? g[k++]));
  }
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const s = startFeeShim({ port: Number(arg("--port")), target: arg("--target")!, tipWei: BigInt(arg("--tip") ?? "0") });
  console.log(`fee-shim: ${s.url} -> ${arg("--target")} (eth_maxPriorityFeePerGas ${arg("--tip") ?? "0"} wei)`);
  const stop = () => (s.stop(), process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
