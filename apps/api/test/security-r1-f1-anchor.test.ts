// Security review r1, review-r1:6 F1 (server side): the api's anchor reader takes the address from the deployment
// record of the network's chain, never from a free env value on testnet or mainnet, and checks the RPC's chain id
// before using any answer. Without a deployed anchor there is no reader, and /verify never reads valid.
import { afterAll, describe, expect, test } from "bun:test";
import { anchorReaderFromEnv } from "../src/routes/receipts.routes";

// port 0: the OS picks a free port, so this never clashes with another run on the same host
const srv = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(r) {
    const j = (await r.json()) as { id: number; method: string };
    // a node that serves chain 1, whatever it is asked
    if (j.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: j.id, result: "0x1" });
    return Response.json({ jsonrpc: "2.0", id: j.id, result: `0x${"11".repeat(32)}${"0".repeat(128)}` });
  },
});
const PORT = srv.port;
afterAll(() => srv.stop(true));

describe("security r1 F1 anchor reader", () => {
  test("testnet-ignores-env-anchor-address", async () => {
    // no anchor in contracts/deployments for 46630 yet: a free ANCHOR_ADDRESS must not be trusted
    expect(await anchorReaderFromEnv({ CAPSTAN_NETWORK: "testnet", ANCHOR_ADDRESS: "0x00000000000000000000000000000000000a1c40", ANCHOR_RPC_URL: `http://127.0.0.1:${PORT}` })).toBeNull();
  });

  test("local-reader-checks-chain-id", async () => {
    const r = await anchorReaderFromEnv({ CAPSTAN_NETWORK: "local", ANCHOR_ADDRESS: "0x00000000000000000000000000000000000a1c40", ANCHOR_RPC_URL: `http://127.0.0.1:${PORT}`, ANCHOR_CHAIN_ID: "31337" });
    expect(r).not.toBeNull();
    const e = await r!.readRoot(490_000).then(() => null, (x: Error) => x);
    expect(e?.message).toContain("not 31337");
  });
});
