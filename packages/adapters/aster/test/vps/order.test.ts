// R13 (todo 15), VPS only (BACKLOG A4): a tiny LIMIT IOC with builder and feeRate 0.0002 is accepted on testnet, a
// tampered feeRate is refused locally first, and the builder commission report later shows the row.
import { CapstanError, type Hex } from "@capstan/schema";
import { accountSigner, AsterNonce, digestTrade, digestTypedData, payloadHashOf, queryString } from "@capstan/signer-aster";
import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAdapter } from "../../src/adapter";
import { ASTER_TESTNET } from "../../src/config";
import { buildOnboarding, submitOnboarding } from "../../src/onboarding";
import type { AsterOrderPayload } from "../../src/orders";
import { createAsterReader } from "../../src/read";
import { castAddress, castSigner, record, serverTimeMs, signedGet, SKIP_REASON, testnetOnly, VPS } from "./helpers";

const vps = VPS ? test : test.skip;
const BUILDER = (process.env.ASTER_TESTNET_BUILDER ?? "") as Hex;
const SYMBOL = process.env.ASTER_TESTNET_SYMBOL ?? "BTCUSDT";

describe(`aster testnet order (${VPS ? "running" : SKIP_REASON})`, () => {
  vps(
    "fill-with-fee",
    async () => {
      const { http } = testnetOnly();
      const owner = castAddress();
      const agent = privateKeyToAccount(generatePrivateKey());
      const now = await serverTimeMs(http);
      const b = buildOnboarding({ owner, agentAddress: agent.address, mode: "direct", network: "Testnet", nowMs: now }, { relayEgressIp: "", builder: BUILDER, nonce: new AsterNonce(), serverTimeMs: now, eligibilityStep: { kind: "eligibility_declaration", signer: "main_wallet", personalSignText: "testnet run" } });
      const sigs = [];
      for (let i = 0; i < b.steps.length; i++) if (b.steps[i]!.venueTx) sigs.push({ step: i, sig: await castSigner(digestTypedData(b.steps[i]!.typedData!)) });
      expect((await submitOnboarding({ bundleId: b.bundleId, signatures: sigs }, http, b, Date.now())).steps.every((s) => s.status === "accepted")).toBe(true);
      const reader = createAsterReader(ASTER_TESTNET, http, null);
      const adapter = createAdapter({ ...ASTER_TESTNET, builder: BUILDER, execution: true }, { http, cache: null, reader });
      const book = await reader.getBook(`aster:-:${SYMBOL}`, 5);
      const market = (await reader.listMarkets()).find((m) => m.venueSymbol === SYMBOL)!;
      const ctx = { owner, agentRef: "vps", identity: { venue: "aster" as const, owner, agentAddress: agent.address }, builderFee: { decimalRate: "0.0002" }, approvedMaxBps: 3, nowMs: Date.now(), eligibilityDecisionId: "vps", policyId: null };
      // a buy far under the market: IOC, so it is accepted and expires without risk
      const px = String(Math.max(Number(market.tickSize), Math.floor((Number(book.bids[0]![0]) * 0.8) / Number(market.tickSize)) * Number(market.tickSize)));
      const build = await adapter.buildOrder({ marketId: market.id, side: "buy", size: market.lotSize, type: "limit", limitPx: px, tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, ctx).catch((e: CapstanError) => e);
      if (build instanceof CapstanError) throw build;
      const p = build.payload as AsterOrderPayload;
      const qs = queryString(p.params);
      const sig = await accountSigner(agent)(digestTrade(qs, 714));
      const env = { buildId: build.buildId, venue: "aster" as const, encoding: "aster_v3_params" as const, signedBody: qs, signature: sig, signerRef: agent.address, payloadHash: payloadHashOf(qs) };
      const tq = qs.replace("feeRate=0.0002", "feeRate=0.0003");
      expect(adapter.verifySigned({ ...env, signedBody: tq, payloadHash: payloadHashOf(tq) }, build)).toMatchObject({ ok: false, field: "feeRate" });
      expect(adapter.verifySigned(env, build)).toEqual({ ok: true });
      const res = await adapter.submit(env);
      await record("order-submit", res);
      expect(res.status).toBe("accepted");
      // builder commission rows (signed by the builder account); fee rows appear only for fills, so record what is seen
      const builderNonce = new AsterNonce();
      const view = await signedGet(http, "/fapi/v3/builder/userCommissions", [["asterChain", "Testnet"], ["user", BUILDER], ["signer", BUILDER], ["nonce", builderNonce.next(BigInt(Date.now()) * 1000n)]], castSigner, (q) => digestTrade(q, 714));
      await record("builder-user-commissions", view);
    },
    180_000,
  );
});
