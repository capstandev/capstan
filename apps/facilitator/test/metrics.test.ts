// Metrics wiring (todo 37): the facilitator counts x402 settle failures and settles per network, read from /metrics.
import { logger } from "@capstan/core";
import { metricsHandler, metricValue } from "@capstan/telemetry";
import { NETWORKS } from "@capstan/x402";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { describe, expect, test } from "bun:test";
import { broadcastTracker, createFacilitatorService } from "../src/service";
import { memoryPaymentStore } from "../src/store";

const scrape = async () => (await metricsHandler()(new Request("http://127.0.0.1/metrics")).text());
const quiet = logger("test", { sink: () => {} });

function body(nonce: string) {
  const req: PaymentRequirements = { scheme: "exact", network: NETWORKS.rhcTestnet as PaymentRequirements["network"], asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F", amount: "10000", payTo: "0x00000000000000000000000000000000000000aa", maxTimeoutSeconds: 60, extra: { name: "Global Dollar", version: "1" } };
  const payload: PaymentPayload = { x402Version: 2, resource: { url: "https://api.example.test/v1/funding/forecast" }, accepted: req, payload: { signature: `0x${"ee".repeat(65)}`, authorization: { from: "0x00000000000000000000000000000000000000bb", to: req.payTo, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: `0x${nonce.repeat(32)}` } } };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: req };
}

function service(settleOk: boolean) {
  const tracker = broadcastTracker();
  const f = {
    verify: async () => ({ isValid: true, payer: "0x00000000000000000000000000000000000000bb" }),
    settle: async (_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> => (settleOk ? { success: true, transaction: `0x${"12".repeat(32)}`, network: r.network } : { success: false, errorReason: "insufficient_funds", transaction: "", network: r.network }),
    getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
  };
  const probe = { receipt: async () => "success" as const, known: async () => true };
  return createFacilitatorService({ facilitator: f as never, store: memoryPaymentStore(), tracker, probes: { [NETWORKS.rhcTestnet]: probe }, log: quiet, alert: () => {}, isArmed: () => false });
}

describe("facilitator metrics", () => {
  test("settle-fail-emitted: a failed settle moves capstan_x402_settle_fail_total, a good one capstan_x402_settled_total", async () => {
    const label = { key: "network", value: NETWORKS.rhcTestnet };
    const fail0 = metricValue(await scrape(), "capstan_x402_settle_fail_total", label) ?? 0;
    const ok0 = metricValue(await scrape(), "capstan_x402_settled_total", label) ?? 0;
    expect((await service(false).settle(body("0a"))).body.success).toBe(false);
    expect((await service(true).settle(body("0b"))).body.success).toBe(true);
    const text = await scrape();
    expect(metricValue(text, "capstan_x402_settle_fail_total", label)).toBe(fail0 + 1);
    expect(metricValue(text, "capstan_x402_settled_total", label)).toBe(ok0 + 1);
  });
});
