// R7: two posts in flight get consecutive nonces; a failed transaction triggers a resync from the pending count; a
// restart resumes without a nonce gap or a reuse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildTree } from "@capstan/receipts";
import type { Hex } from "@capstan/schema";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { ANCHOR_ABI, NonceManager } from "../../src/anchor";
import { ANVIL, fixture, pastHour, PG, T, type Fixture } from "./fixture";

(PG && ANVIL ? describe : describe.skip)("nonce manager", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await fixture("nonce");
  }, T);
  afterAll(() => fx?.drop(), T);

  async function send(nonce: number, hour: number): Promise<Hex> {
    const data = encodeFunctionData({ abi: ANCHOR_ABI, functionName: "postRoot", args: [BigInt(hour), keccak256(toHex(`root-${hour}`)), 1] });
    const block = await fx.rpc.getBlock();
    const raw = await fx.poster.signTransaction!({ chainId: 31337, to: fx.anchor, data, nonce, gas: 200_000n, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + 1n, maxPriorityFeePerGas: 0n });
    return fx.rpc.sendRawTransaction({ serializedTransaction: raw });
  }

  test(
    "sequential-resync-restart",
    async () => {
      const m = new NonceManager(fx.db, fx.rpc, "anchor-poster", fx.poster.address, 31337);
      const p0 = await m.resync();
      expect(p0).toBe(await fx.rpc.getTransactionCount({ address: fx.poster.address, blockTag: "pending" }));
      // two in flight at once: consecutive
      const [a, b] = await Promise.all([m.next(), m.next()]);
      expect([a, b].sort((x, y) => x - y)).toEqual([p0, p0 + 1]);
      expect(m.inFlight()).toEqual([p0, p0 + 1]);
      const h = pastHour(20);
      const ha = await send(Math.min(a, b), h);
      const hb = await send(Math.max(a, b), h + 1);
      await fx.rpc.waitForTransactionReceipt({ hash: ha });
      await fx.rpc.waitForTransactionReceipt({ hash: hb });
      await m.confirm(a);
      await m.confirm(b);
      expect(m.inFlight()).toEqual([]);

      // a failure: a nonce handed out but its transaction never landed; resync takes it back (no gap)
      const lost = await m.next();
      expect(lost).toBe(p0 + 2);
      expect(await m.stored()).toBe(p0 + 3);
      await m.resync();
      expect(await m.stored()).toBe(p0 + 2);
      expect(await m.next()).toBe(p0 + 2); // reused only because it was never sent
      await m.resync();

      // a restart: a fresh manager (same DB) resyncs on start; a nonce sent before the crash is never reused
      const sent = await m.next();
      const hs = await send(sent, h + 2);
      await fx.rpc.waitForTransactionReceipt({ hash: hs });
      const restarted = new NonceManager(fx.db, fx.rpc, "anchor-poster", fx.poster.address, 31337);
      await restarted.resync();
      const after = await restarted.next();
      expect(after).toBe(sent + 1);
      // and the stored value is ahead of what the chain has seen only by the nonces in flight
      expect(await restarted.stored()).toBe(sent + 2);
      expect(buildTree([keccak256(toHex("x"))]).root).toBeDefined();
    },
    T,
  );

  test("refuses a key that is not a service name", () => {
    expect(() => new NonceManager(fx.db, fx.rpc, "0xabc key", fx.poster.address, 31337)).toThrow();
  });
});
