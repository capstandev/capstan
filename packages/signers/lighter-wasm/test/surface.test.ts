// R9: the export list equals the allowlist and nothing names transfer, withdraw, sub-accounts, pools, stake or
// margin. R10: ApproveIntegrator refuses any non-zero fee.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import * as mod from "../src/index";
import { createLighterHasher, createLighterSigner } from "../src/index";
import { PKG } from "./helpers";

const FORBIDDEN = /transfer|withdraw|subaccount|pool|stake|margin/i;
const MODULE_EXPORTS = ["LIGHTER_GO_COMMIT", "WASM_EXEC_SHA256", "WASM_SHA256", "createLighterHasher", "createLighterSigner"];
const SIGNER_METHODS = [
  "chainId",
  "close",
  "createAuthToken",
  "exportEncrypted",
  "generateApiKey",
  "importEncrypted",
  "signApproveIntegrator",
  "signCancelAll",
  "signCancelOrder",
  "signChangePubKey",
  "signCreateOrder",
];
const HASHER_METHODS = ["close", "txHashForCancel", "txHashForOrder"];
// the only WASM globals the worker may call
const WASM_CALLS = ["CreateAuthToken", "CreateClient", "GenerateAPIKey", "SignApproveIntegrator", "SignCancelAllOrders", "SignCancelOrder", "SignChangePubKey", "SignCreateOrder"];

describe("trade-only surface", () => {
  test("trade-only-surface", async () => {
    expect(Object.keys(mod).sort()).toEqual(MODULE_EXPORTS);
    for (const k of Object.keys(mod)) expect(k).not.toMatch(FORBIDDEN);
    expect(mod.LIGHTER_GO_COMMIT).toBe("aefa96848a105d82a6bbb55d3d05663293a71713");

    const s = await createLighterSigner(304);
    expect(Object.keys(s).sort()).toEqual(SIGNER_METHODS);
    expect(Object.isFrozen(s)).toBe(true);
    for (const k of Object.keys(s)) expect(k).not.toMatch(FORBIDDEN);
    s.close();
    const h = await createLighterHasher(304);
    expect(Object.keys(h).sort()).toEqual(HASHER_METHODS);
    h.close();

    // the worker source calls only allowlisted WASM functions and never CheckClient
    const worker = readFileSync(join(PKG, "src/worker.mjs"), "utf8");
    const called = [...worker.matchAll(/goCall\("([A-Za-z]+)"/g)].map((m) => m[1]!);
    expect([...new Set(called)].sort()).toEqual(WASM_CALLS);
    expect(/goCall\("CheckClient"|globalThis\.CheckClient|\.CheckClient\(/.test(worker)).toBe(false);
    const ops = [...worker.matchAll(/^  ([a-zA-Z]+)\(/gm)].map((m) => m[1]!);
    for (const op of ops) expect(op).not.toMatch(FORBIDDEN);
  });

  test("the worker refuses any operation outside its table", async () => {
    const wasm = readFileSync(join(PKG, "artifacts/lighter-signer.wasm"));
    const wasmExecSource = readFileSync(join(PKG, "artifacts/wasm_exec.js"), "utf8");
    for (const mode of ["signer", "hasher"] as const) {
      const w = new Worker(new URL("../src/worker.mjs", import.meta.url));
      const replies = new Map<number, { ok: boolean; error?: string }>();
      const waiters = new Map<number, () => void>();
      w.on("message", (m: { id: number; ok: boolean; error?: string }) => {
        replies.set(m.id, m);
        waiters.get(m.id)?.();
      });
      let id = 0;
      const call = (op: string, args?: unknown) =>
        new Promise<{ ok: boolean; error?: string }>((res) => {
          const my = ++id;
          waiters.set(my, () => res(replies.get(my)!));
          w.postMessage({ id: my, op, args });
        });
      const buf = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
      expect((await call("boot", { wasm: buf, wasmExecSource, chainId: 304, mode })).ok).toBe(true);
      const banned = ["signTransfer", "SignTransfer", "signWithdraw", "SignWithdraw", "signCreateSubAccount", "signCreatePublicPool", "signStakeAssets", "signUpdateMargin", "checkClient", "toString", "__proto__", "constructor"];
      const hasherBanned = [...banned, "exportRaw", "commitKey", "importKey", "signCreateOrder", "signChangePubKey", "createAuthToken"];
      for (const op of mode === "hasher" ? hasherBanned : banned) {
        const r = await call(op, {});
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/is not offered by a/);
      }
      await w.terminate();
    }
  });

  test("zero-fee-only", async () => {
    const s = await createLighterSigner(466324);
    s.generateApiKey();
    const base = { integratorAccountIndex: 77, maxPerpsTakerFee: 0, maxPerpsMakerFee: 0, maxSpotTakerFee: 0, maxSpotMakerFee: 0, approvalExpiryMs: 1_893_456_000_000, nonce: 3, apiKeyIndex: 4, accountIndex: 12345 } as const;
    for (const f of ["maxPerpsTakerFee", "maxPerpsMakerFee", "maxSpotTakerFee", "maxSpotMakerFee"] as const) {
      for (const v of [1, 10, 1000]) await expect(s.signApproveIntegrator({ ...base, [f]: v } as never)).rejects.toThrow(/fees must all be 0/);
    }
    const ok = await s.signApproveIntegrator(base);
    expect(ok.txType).toBe(45);
    const info = JSON.parse(ok.txInfo);
    expect([info.MaxPerpsTakerFee, info.MaxPerpsMakerFee, info.MaxSpotTakerFee, info.MaxSpotMakerFee]).toEqual([0, 0, 0, 0]);
    expect(info.IntegratorAccountIndex).toBe(77);
    // orders refuse integrator fees too
    await expect(
      s.signCreateOrder({ marketIndex: 1, clientOrderIndex: 1, baseAmount: 1, price: 1, isAsk: false, orderType: 0, timeInForce: 0, reduceOnly: false, triggerPrice: 0, orderExpiry: 0, integratorAccountIndex: 77, integratorTakerFee: 5 as 0, integratorMakerFee: 0, selfTradeBehaviorMode: 0, selfTradeEqualityMode: 0, nonce: 4, apiKeyIndex: 4, accountIndex: 12345 }),
    ).rejects.toThrow(/integrator fees must be 0/);
    s.close();
  });
});
