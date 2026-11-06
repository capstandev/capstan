// The fork's front door answers the real chain's priority fee and passes everything else to the local anvil.
import { afterAll, describe, expect, test } from "bun:test";
import { startFeeShim } from "../fee-shim";

describe("fee-shim", () => {
  const seen: string[] = [];
  const anvil = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const b = (await req.json()) as any; const arr = Array.isArray(b) ? b : [b]; for (const r of arr) seen.push(r.method); const out = arr.map((r: any) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_maxPriorityFeePerGas" ? "0x3b9aca00" : "0x1" })); return Response.json(Array.isArray(b) ? out : out[0]); } });
  const shim = startFeeShim({ port: 0, target: `http://127.0.0.1:${anvil.port}`, tipWei: 0n });
  afterAll(() => (shim.stop(), anvil.stop(true)));
  const rpc = async (body: unknown) => (await fetch(shim.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;

  test("real-chain-tip-and-pass-through", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "eth_maxPriorityFeePerGas", params: [] })).result).toBe("0x0");
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x02"] })).result).toBe("0x1");
    const b = await rpc([{ jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] }, { jsonrpc: "2.0", id: 4, method: "eth_maxPriorityFeePerGas", params: [] }, { jsonrpc: "2.0", id: 5, method: "eth_blockNumber", params: [] }]);
    expect(b.map((x: any) => [x.id, x.result])).toEqual([[3, "0x1"], [4, "0x0"], [5, "0x1"]]);
    expect((await rpc({ jsonrpc: "2.0", id: 6, method: "eth_fillTransaction", params: [{}] })).error.code).toBe(-32601);
    expect(seen).toEqual(["eth_sendRawTransaction", "eth_chainId", "eth_blockNumber"]);
    expect(() => startFeeShim({ port: 0, target: "https://rpc.mainnet.chain.robinhood.com", tipWei: 0n })).toThrow(/local anvil only/);
  });
});
