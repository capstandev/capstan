// Node timing run (also used by test/timing.test.ts): cold start, then 1,000 signCreateOrder calls through the
// Worker. Prints one JSON line with p50/p99. No key is printed.
// Usage: node packages/signers/lighter-wasm/test/timing-node.mjs
import { createLighterSigner } from "../src/index.ts";

const N = 1000;
const t0 = performance.now();
const s = await createLighterSigner(304);
const coldMs = performance.now() - t0;
s.generateApiKey();
const ds = [];
for (let i = 0; i < N; i++) {
  const o = { marketIndex: i % 200, clientOrderIndex: i + 1, baseAmount: 1000 + i, price: 50_000 + i, isAsk: i % 2 === 1, orderType: 0, timeInForce: 1, reduceOnly: false, triggerPrice: 0, orderExpiry: 1_893_542_400_000, integratorAccountIndex: 0, integratorTakerFee: 0, integratorMakerFee: 0, selfTradeBehaviorMode: 0, selfTradeEqualityMode: 0, nonce: i, apiKeyIndex: 4, accountIndex: 12345, expiredAt: 1_893_456_000_000 };
  const a = performance.now();
  await s.signCreateOrder(o);
  ds.push(performance.now() - a);
}
s.close();
ds.sort((x, y) => x - y);
const q = (p) => ds[Math.min(ds.length - 1, Math.floor(p * ds.length))];
const out = { runtime: `node ${process.version}`, n: N, coldMs: +coldMs.toFixed(1), p50Ms: +q(0.5).toFixed(3), p99Ms: +q(0.99).toFixed(3), maxMs: +ds[ds.length - 1].toFixed(3) };
console.log(JSON.stringify(out));
