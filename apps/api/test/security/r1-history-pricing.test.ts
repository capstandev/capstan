// Security review r1 review-r1:3 F2 + review-r1:4 F2 (one issue): GET /v1/history/funding was priced at the x402 gate
// from ?limit= (which the route does not have), while the handler delivered a full page. No limit paid 1 unit ($0.05)
// for up to 10,000 rows ($0.50); limit=10000 on a 10-row window paid $0.50. After the fix the gate calls the route's
// own priceRequest on the same Request and charges what the handler delivers. Real x402 gate and middleware, real
// funding route and handler, real x402 client signatures; a fake facilitator and an in-memory history of 2,500 rows.
import { describe, expect, test } from "bun:test";
import { memoryCatalog } from "@capstan/quote";
import { clientSpendControls, createResourceServer, NETWORKS, paymentGate, railDefs, type X402State } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { labelAccount } from "../../../../packages/x402/test/helpers/chain";
import { x402Verifier } from "../../src/auth";
import { guardedPayment, pricedRoutes } from "../../src/auth/env";
import { createFundingRoutes, HISTORY_PAGE_ROWS, historyPriceUsd, type HistoryReader, type HistoryRow } from "../../src/routes/funding.routes";
import { smallApp } from "../gw-helpers";

const payer = labelAccount("r1-history-payer");
const defs = railDefs("testnet");
const state = (): X402State => ({
  usdgEip3009: { "4663": false, "46630": false },
  payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
  tokens: { "base-usdc": { asset: defs["base-usdc"].asset, decimals: 6, name: defs["base-usdc"].domain!.name, version: defs["base-usdc"].domain!.version } },
  droppedRails: ["rhc-usdg-permit2", "rhc-usdg-eip3009"],
});
const settled: string[] = [];
const facilitator: FacilitatorClient = {
  async verify(p: PaymentPayload) {
    return { isValid: true, payer: (p.payload as { authorization?: { from?: string } }).authorization?.from ?? payer.address };
  },
  async settle(_p: PaymentPayload, r: PaymentRequirements) {
    settled.push(r.amount);
    return { success: true, transaction: `0x${settled.length.toString(16).padStart(64, "0")}`, network: r.network, payer: payer.address };
  },
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORKS.baseSepolia }], extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
  },
};

const NOW = Date.parse("2026-11-06T12:00:00Z");
const TOTAL = 2_500;
/** One funding tick a minute for TOTAL minutes, counted and paged the way dbHistoryReader does. */
let rowReads = 0;
const history: HistoryReader = {
  async page(marketId, from, to, cursor, opts = {}) {
    if (!opts.countOnly) rowReads++;
    const all: HistoryRow[] = Array.from({ length: TOTAL }, (_, i) => ({ ts: new Date(NOW - (TOTAL - i) * 60_000).toISOString(), marketId, ratePerInterval: "0.00001", intervalS: 3600, ratePerHour: "0.00001", rateAnnualised: "0.0876", source: "venue" }));
    const lo = cursor ?? from;
    const inWindow = all.filter((r) => Date.parse(r.ts) >= lo.getTime() && Date.parse(r.ts) <= to.getTime());
    const rows = inWindow.slice(0, Math.min(inWindow.length, HISTORY_PAGE_ROWS, opts.maxRows ?? HISTORY_PAGE_ROWS));
    return { window: { from: from.toISOString(), to: to.toISOString() }, totalRows: inWindow.length, rows, pricing: { rows: rows.length, usd: historyPriceUsd(rows.length), perThousandUsd: "0.05" }, nextCursor: null };
  },
};

describe("r1 F2: history is charged for the rows delivered", () => {
  test("the settled amount equals ceil(rows delivered / 1000) x $0.05, whatever ?limit= says", async () => {
    const specs = createFundingRoutes(() => ({ catalog: memoryCatalog([]), cache: { getFunding: async () => null }, forecasts: { get: async () => null }, history, now: () => NOW })).filter((r) => r.path === "/history/funding");
    const { app } = await smallApp(specs, {
      verifiers: { x402: x402Verifier(null) },
      payment: guardedPayment(paymentGate(pricedRoutes(specs), createResourceServer(facilitator), { env: "testnet", state, syncFacilitatorOnStart: true })),
    });
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "5"));
    const window = `marketId=hyperliquid:-:BTC&from=${new Date(NOW - 30 * 86_400_000).toISOString()}&to=${new Date(NOW).toISOString()}`;
    for (const q of ["", "&limit=1", "&limit=10000"]) {
      settled.length = 0;
      const path = `/v1/history/funding?${window}${q}`;
      rowReads = 0;
      const r1 = await app.request(path);
      expect(r1.status, q).toBe(402);
      // an unpaid request is quoted by a count only: it never costs a page read
      expect(rowReads, q).toBe(0);
      const required = decodePaymentRequiredHeader(r1.headers.get("PAYMENT-REQUIRED")!);
      const r2 = await app.request(path, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(await client.createPaymentPayload(required)) } });
      expect(r2.status, q).toBe(200);
      const page = (await r2.json()) as { rows: unknown[]; charged: { usd: string } };
      const units = Math.max(1, Math.ceil(page.rows.length / 1000));
      expect(page.rows.length, q).toBe(TOTAL);
      // what was settled on chain is what the rows cost: 3 units = $0.15 = 150000 atomic USDC
      expect(settled, q).toEqual([String(units * 50_000)]);
      expect(page.charged.usd).toBe(historyPriceUsd(page.rows.length));
    }
  });
});
