// R15: SignCreateOrder takes 19 positional args (venue-lighter.md "Order tx format"); the wrapper passes each in its
// exact position, with skipNonce always 0. Checked against the spike call order and by reading the signed txInfo.
import { describe, expect, test } from "bun:test";
import { createLighterSigner, type LighterOrderArgs } from "../src/index";
import { createOrderArgs } from "../src/worker.mjs";

// lighter-go aefa968 wasm/main.go, SignCreateOrder argument list (also the spike's bench/vectors.mjs call)
const ORDER = [
  "marketIndex",
  "clientOrderIndex",
  "baseAmount",
  "price",
  "isAsk",
  "orderType",
  "timeInForce",
  "reduceOnly",
  "triggerPrice",
  "orderExpiry",
  "integratorAccountIndex",
  "integratorTakerFee",
  "integratorMakerFee",
  "selfTradeBehaviorMode",
  "selfTradeEqualityMode",
  "skipNonce",
  "nonce",
  "apiKeyIndex",
  "accountIndex",
] as const;

describe("SignCreateOrder args", () => {
  test("nineteen-positional", async () => {
    // distinct marker per field so a swapped position shows up
    const o: LighterOrderArgs = {
      marketIndex: 101,
      clientOrderIndex: 202,
      baseAmount: 303,
      price: 404,
      isAsk: true,
      orderType: 4,
      timeInForce: 2,
      reduceOnly: true,
      triggerPrice: 909,
      orderExpiry: 1_893_456_000_010,
      integratorAccountIndex: 1111,
      integratorTakerFee: 0,
      integratorMakerFee: 0,
      selfTradeBehaviorMode: 2,
      selfTradeEqualityMode: 1,
      nonce: 1717,
      apiKeyIndex: 18,
      accountIndex: 1919,
    };
    const args = createOrderArgs(o as unknown as Record<string, unknown>);
    expect(args.length).toBe(19);
    ORDER.forEach((name, i) => {
      if (name === "skipNonce") expect(args[i]).toBe(0);
      else if (name === "isAsk" || name === "reduceOnly") expect(args[i]).toBe(1);
      else expect(args[i]).toBe(o[name] as number);
    });
    // the spike called SignCreateOrder(market, coi, base, price, isAsk, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, nonce, 4, 12345)
    const spike = createOrderArgs({ ...o, orderType: 0, timeInForce: 1, isAsk: false, reduceOnly: false, triggerPrice: 0, orderExpiry: -1, integratorAccountIndex: 0, selfTradeBehaviorMode: 0, selfTradeEqualityMode: 0, apiKeyIndex: 4, accountIndex: 12345 });
    expect(spike.slice(4)).toEqual([0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1717, 4, 12345]);

    // and the WASM put each value in the matching txInfo field (stop-loss style order with a trigger)
    const s = await createLighterSigner(304);
    s.generateApiKey();
    const t = await s.signCreateOrder({ ...o, orderType: 2, timeInForce: 0, orderExpiry: 1_893_456_000_010, selfTradeBehaviorMode: 0, selfTradeEqualityMode: 0, expiredAt: 1_893_456_000_000 });
    const info = JSON.parse(t.txInfo);
    expect(info).toMatchObject({ MarketIndex: 101, ClientOrderIndex: 202, BaseAmount: 303, Price: 404, IsAsk: 1, Type: 2, TimeInForce: 0, ReduceOnly: 1, TriggerPrice: 909, OrderExpiry: 1_893_456_000_010, ExpiredAt: 1_893_456_000_000, Nonce: 1717, ApiKeyIndex: 18, AccountIndex: 1919 });
    // integrator index travels as L2 tx attribute 1; fees 0 are the nil value and are omitted
    expect(info.L2TxAttributes?.["1"]).toBe(1111);
    expect(info.L2TxAttributes?.["2"]).toBeUndefined();
    expect(info.L2TxAttributes?.["4"]).toBeUndefined(); // skipNonce never set
    // self-trade modes travel as attributes 6 and 7 when not the defaults (0, 0), only without integrator fees
    const t2 = await s.signCreateOrder({ ...o, orderType: 0, timeInForce: 1, triggerPrice: 0, integratorAccountIndex: 0, selfTradeBehaviorMode: 2, selfTradeEqualityMode: 1, nonce: 1718, expiredAt: 1_893_456_000_000 });
    const info2 = JSON.parse(t2.txInfo);
    expect(info2.L2TxAttributes?.["6"]).toBe(2);
    expect(info2.L2TxAttributes?.["7"]).toBe(1);
    s.close();
  });
});

describe("cancel order index range", () => {
  test("venue order indexes above 2^48 are accepted, 0 and unsafe integers refused", async () => {
    const s = await createLighterSigner(304);
    try {
      s.generateApiKey();
      // a live ask order index from mainnet orderBookOrders (2026-11-06) and a bid index near 2^49
      for (const orderIndex of [281478187963734, 562946627628587, 5]) {
        const r = await s.signCancelOrder({ marketIndex: 0, orderIndex, nonce: 6, apiKeyIndex: 4, accountIndex: 99, expiredAt: 1793934000000 });
        expect(JSON.parse(r.txInfo).Index).toBe(orderIndex);
      }
      for (const orderIndex of [0, 2 ** 53]) await expect(s.signCancelOrder({ marketIndex: 0, orderIndex, nonce: 6, apiKeyIndex: 4, accountIndex: 99 })).rejects.toThrow(/orderIndex/);
    } finally {
      s.close();
    }
  });
});
