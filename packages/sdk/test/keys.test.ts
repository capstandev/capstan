// R5: the delegated private key never leaves the KeyStore. fetch, postMessage (page and Worker) and console are
// spied during onboard, build, sign, submit and kill; no hex or base64 form of any secret appears. For Lighter the
// raw key only crosses into or out of the signer's own Worker (importKey / exportRaw), never anywhere else.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OrderIntent } from "@capstan/schema";
import { createLighterHasher, createLighterSigner } from "@capstan/signer-lighter-wasm";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createClient } from "../src/client";
import { memoryKeyStore } from "../src/keys/memory";
import type { LighterSignerFactory } from "../src/keys/types";
import { signEnvelope } from "../src/sign";
import { PINS } from "../src/pins";
import { SdkError } from "../src/errors";
import { BUILDER_ASTER, BUILDER_HL, LIGHTER_ACCT, lighterBuild, T0 } from "./helpers";
import { hlTemplatePin, startStack } from "./stack";
import { testWallet } from "./wallet-fixture";

type Capture = { where: string; data: unknown };
const captured: Capture[] = [];

function forms(bytes: Uint8Array): string[] {
  const hex = Buffer.from(bytes).toString("hex");
  return [hex, hex.toUpperCase(), Buffer.from(bytes).toString("base64"), Buffer.from(bytes).toString("base64url")];
}

function text(v: unknown, seen = new Set<unknown>()): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof ArrayBuffer) return forms(new Uint8Array(v)).join(" ");
  if (ArrayBuffer.isView(v)) return forms(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).join(" ");
  if (v instanceof URLSearchParams || v instanceof URL) return v.toString();
  if (typeof v === "object") {
    if (seen.has(v)) return "";
    seen.add(v);
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}:${text(x, seen)}`).join(" ");
  }
  return "";
}

const originals = { fetch: globalThis.fetch, post: (globalThis as { postMessage?: unknown }).postMessage, workerPost: Worker.prototype.postMessage, log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ where: "fetch", data: [String(input instanceof Request ? input.url : input), init?.body ?? "", init?.headers ?? ""] });
    return originals.fetch(input, init);
  }) as typeof fetch;
  (globalThis as { postMessage?: unknown }).postMessage = (m: unknown) => captured.push({ where: "postMessage", data: m });
  Worker.prototype.postMessage = function (this: Worker, m: unknown, t?: unknown) {
    captured.push({ where: "worker", data: m });
    return (originals.workerPost as (m: unknown, t?: unknown) => void).call(this, m, t as never);
  } as typeof Worker.prototype.postMessage;
  for (const k of ["log", "info", "warn", "error", "debug"] as const) console[k] = (...a: unknown[]) => void captured.push({ where: `console.${k}`, data: a });
});
afterAll(() => {
  globalThis.fetch = originals.fetch;
  (globalThis as { postMessage?: unknown }).postMessage = originals.post;
  Worker.prototype.postMessage = originals.workerPost;
  Object.assign(console, { log: originals.log, info: originals.info, warn: originals.warn, error: originals.error, debug: originals.debug });
});

function assertNoSecret(secrets: Uint8Array[], allow: (c: Capture) => boolean = () => false): number {
  let scanned = 0;
  for (const c of captured) {
    const t = text(c.data);
    scanned++;
    for (const s of secrets) for (const f of forms(s)) if (t.includes(f) && !allow(c)) throw new Error(`secret found in ${c.where}`);
  }
  return scanned;
}

describe("keys", () => {
  test("never-leaves", async () => {
    const stack = await startStack();
    try {
      const pin = await hlTemplatePin(stack.apiBase);
      const seeds: Uint8Array[] = [];
      const ks = memoryKeyStore({ random: (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); if (n === 48) seeds.push(b.slice()); return b; } });
      const client = createClient({
        apiBase: stack.apiBase,
        network: "mainnet",
        keystore: ks,
        walletSigner: testWallet(),
        pinned: { networks: { mainnet: { ...PINS.networks.mainnet, builders: { hyperliquid: BUILDER_HL, aster: BUILDER_ASTER }, templateHashes: { ...PINS.networks.mainnet.templateHashes, hyperliquid: [pin] }, receiptSigners: [{ address: stack.receiptSigner }] } } },
        venueHosts: { hyperliquid: stack.venue.url },
        now: () => T0,
      });
      const d = await client.onboard("hyperliquid");
      const intent: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "sell", size: "0.002", type: "limit", limitPx: "77000", tif: "alo", reduceOnly: false, maxSlippageBps: 50 };
      await client.signAndSubmit(await client.buildOrder(intent, "hyperliquid", "relay"));
      await client.signAndSubmit(await client.buildOrder({ ...intent, side: "buy", limitPx: "76000", tif: "gtc" }, "hyperliquid", "direct"));
      const k = await client.kill(d.agentRef);
      expect(k.serverReached).toBe(true);
      const secrets = seeds.map((s) => secp256k1.utils.randomSecretKey(s));
      expect(secrets.length).toBe(1);
      const n = assertNoSecret(secrets);
      expect(n).toBeGreaterThan(10);
      expect(captured.some((c) => c.where === "fetch")).toBe(true);
      // the key is gone after the kill
      expect(await ks.list()).toEqual([]);
    } finally {
      stack.stop();
    }
  });

  test("lighter key: made and used inside the WASM Worker; raw bytes only cross the Worker boundary", async () => {
    captured.length = 0;
    const raws: Uint8Array[] = [];
    const factory: LighterSignerFactory = async (chainId) => {
      const s = await createLighterSigner(chainId);
      return { ...s, exportEncrypted: (wrap) => s.exportEncrypted(async (raw) => (raws.push(raw.slice()), wrap(raw))) };
    };
    const ks = memoryKeyStore({ lighter: factory });
    const hasher = await createLighterHasher(304);
    try {
      const k = await ks.create("lighter-mainnet", "lighter");
      expect(k.publicPart).toMatch(/^0x[0-9a-f]{80}$/);
      const intent: OrderIntent = { marketId: "lighter-mainnet:-:ETH", side: "buy", size: "0.5", type: "limit", limitPx: "2999.5", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
      const b0 = lighterBuild(intent);
      const args = (b0.payload as { args: Parameters<typeof hasher.txHashForOrder>[0] }).args;
      const digest = `0x${await hasher.txHashForOrder(args)}` as `0x${string}`;
      const env = await signEnvelope({ ...b0, digest }, { keystore: ks, keyRef: k.ref, signerRef: `${LIGHTER_ACCT.accountIndex}:${LIGHTER_ACCT.apiKeyIndex}`, digest, lighterChainId: 304 });
      expect(env.payloadHash).toBe(digest);
      expect(typeof env.signature).toBe("string");
      // a server digest that is not this tx's hash is refused at sign time
      const other = `0x${"00".repeat(31)}01` as `0x${string}`;
      const e = (await signEnvelope({ ...b0, digest: other }, { keystore: ks, keyRef: k.ref, signerRef: "x", digest: other, lighterChainId: 304 }).catch((x) => x)) as SdkError;
      expect([e.code, e.field]).toEqual(["PAYLOAD_MISMATCH", "digest"]);
      expect(raws.length).toBe(1);
      expect(raws[0]!.length).toBe(40);
      // only the import into the signer Worker carries the raw key
      assertNoSecret(raws, (c) => c.where === "worker" && (c.data as { op?: string; method?: string }) !== null && /importKey/.test(JSON.stringify(Object.keys(c.data as object)) + text((c.data as { op?: unknown; method?: unknown }).op ?? (c.data as { method?: unknown }).method ?? "")));
    } finally {
      ks.close?.();
      hasher.close();
    }
  }, 60_000);
});
