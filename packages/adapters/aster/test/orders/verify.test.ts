// R2 (todo 15), spec C3: a tampered feeRate, and any changed, reordered or added param, fails verifySigned with the
// field named.
import type { SignedEnvelope } from "@capstan/schema";
import { parseQuery, payloadHashOf } from "@capstan/signer-aster";
import { describe, expect, test } from "bun:test";
import { firstDifference } from "../../src/verify";
import { agent, ctx, intent, NOW, owner, setup, sign } from "./setup";

const rebuild = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${v}`).join("&");

describe("aster verifySigned", () => {
  test("tampered-fee-and-any-field", async () => {
    const s = setup();
    try {
      const b = await s.adapter.buildOrder(intent(), ctx());
      const env = await sign(b);
      expect(s.adapter.verifySigned(env, b)).toEqual({ ok: true });
      // C3: feeRate tampered (and re-signed by the agent, so only the field check can catch it)
      const tamperedQs = env.signedBody.replace("feeRate=0.0002", "feeRate=0.001");
      const t: SignedEnvelope = { ...env, signedBody: tamperedQs, payloadHash: payloadHashOf(tamperedQs) };
      expect(s.adapter.verifySigned(t, b)).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "feeRate" });
      // property: 200 builds, each with one random mutation
      const muts = ["change", "swap", "add", "drop"] as const;
      for (let i = 0; i < 200; i++) {
        const side = i % 2 ? "buy" : "sell";
        const bi = await s.adapter.buildOrder(intent({ side, size: ["0.001", "0.002", "0.01"][i % 3]!, limitPx: String(60000 + i * 10), tif: (["gtc", "ioc", "alo"] as const)[i % 3]!, reduceOnly: i % 5 === 0 }), ctx({ nowMs: NOW + i }));
        const ei = await sign(bi);
        const pairs = parseQuery(ei.signedBody);
        const m = muts[i % 4]!;
        const j = Math.floor(Math.random() * pairs.length);
        let expected: string;
        const next = pairs.map((p) => [...p] as [string, string]);
        if (m === "change") {
          next[j]![1] = next[j]![1] + "9";
          expected = pairs[j]![0];
        } else if (m === "swap") {
          const k = (j + 1) % pairs.length;
          [next[j], next[k]] = [next[k]!, next[j]!];
          expected = pairs[Math.min(j, k)]![0];
        } else if (m === "add") {
          next.splice(j, 0, ["extra", "1"]);
          expected = "extra";
        } else {
          next.splice(j, 1);
          expected = pairs[j]![0];
        }
        const qs = rebuild(next);
        const r = s.adapter.verifySigned({ ...ei, signedBody: qs, payloadHash: payloadHashOf(qs) }, bi);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.code).toBe("PAYLOAD_MISMATCH");
        expect(r.ok === false && r.field).toBe(expected);
      }
      // wrong signer, wrong signature, stale build, wrong hash, wrong build id
      const byOwner = await sign(b, owner);
      expect(s.adapter.verifySigned(byOwner, b)).toMatchObject({ ok: false, code: "BAD_SIGNATURE" });
      expect(s.adapter.verifySigned({ ...env, signerRef: agent.address, signature: byOwner.signature }, b)).toEqual({ ok: false, code: "BAD_SIGNATURE", field: "signature" });
      expect(s.adapter.verifySigned({ ...env, payloadHash: payloadHashOf("x") }, b)).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "payloadHash" });
      expect(s.adapter.verifySigned({ ...env, buildId: "other" }, b)).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "buildId" });
      expect(s.adapter.verifySigned({ ...env, signedBody: env.signedBody.replace("BTCUSDT", "BTC%55SDT") }, b)).toMatchObject({ ok: false, code: "PAYLOAD_MISMATCH", field: "symbol" });
      const { verifyAsterSigned } = await import("../../src/verify");
      expect(verifyAsterSigned(env, b, b.expiresAt + 1)).toEqual({ ok: false, code: "BUILD_EXPIRED" });
      expect(firstDifference("a=1&b=2", "a=1&b=2")).toBeNull();
    } finally {
      s.stop();
    }
  });
});
