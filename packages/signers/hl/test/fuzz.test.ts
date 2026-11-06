// R8: 50 random orders; viem reproduces the digest independently from the phantom agent and recovery gives the key.
import { describe, expect, test } from "bun:test";
import { hashTypedData } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { actionHash, addressOf, formatPrice, formatSize, l1Digest, recoverSigner, signDigest, type HlNetwork, type HlOrderAction, type HlOrderWire } from "../src";
import { hexOf, pick, prng, randInt, testKeyFrom } from "./helpers";

describe("fuzz", () => {
  test("50-random-orders", () => {
    const r = prng(20261105);
    const key = testKeyFrom("fuzz-50");
    const addr = addressOf(key);
    expect(addr.toLowerCase()).toBe(privateKeyToAddress(hexOf(key)).toLowerCase());
    for (let i = 0; i < 50; i++) {
      const asset = r() < 0.5 ? randInt(r, 0, 230) : randInt(r, 110000, 200018);
      const szDecimals = randInt(r, 0, 5);
      const px = formatPrice(`${randInt(r, 1, 120000)}.${randInt(r, 0, 999999)}`, szDecimals, pick(r, ["up", "down", "nearest"] as const));
      const sz = formatSize(`${randInt(r, 0, 500)}.${randInt(r, 1, 999999)}`, szDecimals);
      const wire: HlOrderWire = { a: asset, b: r() < 0.5, p: px, s: sz, r: r() < 0.3, t: { limit: { tif: pick(r, ["Ioc", "Gtc", "Alo"] as const) } } };
      if (r() < 0.5) wire.c = hexOf(Uint8Array.from({ length: 16 }, () => randInt(r, 0, 255)));
      const f = pick(r, [0, 10, 20] as const);
      const action: HlOrderAction = { type: "order", orders: [wire], grouping: "na", ...(f ? { builder: { b: hexOf(Uint8Array.from({ length: 20 }, () => randInt(r, 0, 255))), f } } : {}) };
      const network: HlNetwork = r() < 0.5 ? "Mainnet" : "Testnet";
      const nonce = 1793900000000 + i;
      const digest = l1Digest(action, null, nonce, network);
      const independent = hashTypedData({
        domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
        types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
        primaryType: "Agent",
        message: { source: network === "Mainnet" ? "a" : "b", connectionId: actionHash(action, null, nonce) },
      });
      expect(digest).toBe(independent);
      expect(recoverSigner(digest, signDigest(digest, key))).toBe(addr);
    }
  });
});
