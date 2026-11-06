// Found on the fork run (todo 40): order builds used a hard-coded zero lock reader, and the relay read the lock from
// the mainnet RPC on every network. One reader now serves every role: the network's chain, its lock and its RPC.
import { describe, expect, test } from "bun:test";
import { DEPLOYMENTS, type Deployment } from "@capstan/schema";
import { lockReaderFromEnv, NO_LOCK } from "../src";

describe("lockReaderFromEnv", () => {
  test("network-chain-lock-and-rpc", async () => {
    const calls: { url: string; to: string }[] = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const b = (await req.json()) as { id: number; method: string; params: [{ to: string }] };
        calls.push({ url: new URL(req.url).pathname, to: b.params[0].to.toLowerCase() });
        // lockedOf -> (1e23, 2e9)
        return Response.json({ jsonrpc: "2.0", id: b.id, result: `0x${(10n ** 23n).toString(16).padStart(64, "0")}${(2_000_000_000n).toString(16).padStart(64, "0")}` });
      },
    });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const LOCK = "0x00000000000000000000000000000000000000b7"; // not-a-key
      expect(lockReaderFromEnv({})).toBe(NO_LOCK);
      // testnet: the testnet RPC only; a mainnet RPC alone gives no reader
      expect(lockReaderFromEnv({ CAPSTAN_NETWORK: "testnet", CPST_LOCK_ADDRESS: LOCK, RHC_RPC_URL: `${base}/main` })).toBe(NO_LOCK);
      const t = lockReaderFromEnv({ CAPSTAN_NETWORK: "testnet", CPST_LOCK_ADDRESS: LOCK, RHC_RPC_URL: `${base}/main`, RHC_TESTNET_RPC_URL: `${base}/test` });
      expect(await t.lockedOf("0x00000000000000000000000000000000000000a1")).toEqual({ amount: 10n ** 23n, unlockAt: 2_000_000_000n });
      expect(calls.at(-1)).toEqual({ url: "/test", to: LOCK });
      // mainnet: the deployment record's lock when no override is set
      const prev = DEPLOYMENTS[4663];
      DEPLOYMENTS[4663] = { chainId: 4663, contracts: { CPSTLock: { address: LOCK } }, deployer: LOCK, sourcify: { verified: false }, updatedAt: "x" } as Deployment;
      try {
        const m = lockReaderFromEnv({ CAPSTAN_NETWORK: "mainnet", RHC_RPC_URL: `${base}/main` });
        expect((await m.lockedOf("0x00000000000000000000000000000000000000a1")).amount).toBe(10n ** 23n);
        expect(calls.at(-1)).toEqual({ url: "/main", to: LOCK });
      } finally {
        if (prev) DEPLOYMENTS[4663] = prev;
        else delete DEPLOYMENTS[4663];
      }
    } finally {
      srv.stop(true);
    }
  });
});
