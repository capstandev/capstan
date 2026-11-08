// Todo 39 follow-up (SDK side): the real API refuses owner_sig routes without the owner's signature or an API key.
// On a stack gated by the real apps/api auth table and verifiers, the SDK onboards, builds, signs, submits and
// verifies a receipt with no extra wallet prompt: onboarding goes through an anonymous API key (no prompt may come
// before the bundle check), every agent-scoped call carries an owner_sig signed by the agent key.
import { parseCapstanMessage, recoverPersonalSigner } from "@capstan/core";
import type { Hex, OrderIntent } from "@capstan/schema";
import { afterAll, describe, expect, test } from "bun:test";
import { SdkError } from "../src/errors";
import { sdkClient, startStack } from "./stack";
import type { testWallet } from "./wallet-fixture";

type TestWallet = ReturnType<typeof testWallet>;

const stacks: Awaited<ReturnType<typeof startStack>>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));
const gated = async () => {
  const s = await startStack({ gate: true });
  stacks.push(s);
  return s;
};
const intent: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
const sha256Hex = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

describe("request auth", () => {
  test("owner-sig-and-key", async () => {
    const s = await gated();
    const { client, wallet: w } = await sdkClient(s);
    const wallet = w as TestWallet;
    const owner = (await wallet.address()).toLowerCase();

    const d = await client.onboard("hyperliquid");
    expect(d.agentActive).toBe(true);
    // only the venue steps reached the wallet: no request signature prompt
    expect(wallet.prompts).toEqual(["typed:Declaration", "typed:HyperliquidTransaction:ApproveAgent", "typed:HyperliquidTransaction:ApproveBuilderFee"]);
    // one anonymous key, made with no signature, carried by the onboarding build and submit
    const made = s.hits.filter((h) => h.path === "/v1/account/keys");
    expect(made.length).toBe(1);
    expect(made[0]!.body).toEqual({ owner: null });
    const sent = s.hits.filter((h) => h.path === "/v1/onboarding/build").at(-1)!.headers.authorization!;
    const key = sent.replace(/^Bearer /, "");
    expect(s.apiKeys.has(key)).toBe(true);
    expect(s.hits.filter((h) => h.path === "/v1/onboarding/submit").at(-1)!.headers.authorization).toBe(`Bearer ${key}`);

    const cb = await client.buildOrder(intent, "hyperliquid", "relay");
    const out = await client.signAndSubmit(cb);
    expect(out.order.status).toBe("open");
    // no anchor is pinned in this client: sound but unchecked, never valid (security r1, review-r1:6 F1)
    expect(await client.verifyReceipt(out.receiptId!)).toMatchObject({ valid: false, status: "unchecked" });
    // the order calls are owner-signed by the agent key over method, path and the raw body; no key needed
    const agent = d.agentRef.replace(/^hl:/, "");
    for (const p of ["/v1/orders/build", "/v1/orders/submit"]) {
      const h = s.hits.filter((x) => x.path === p).at(-1)!;
      expect(h.headers.authorization).toBeUndefined();
      const text = Buffer.from(h.headers["x-capstan-message"]!, "base64").toString("utf8");
      const m = parseCapstanMessage(text)!;
      expect([m.purpose, m.owner.toLowerCase(), m.host]).toEqual(["api_request", owner, new URL(s.apiBase).host]);
      expect(m.expiresAt - m.issuedAt).toBeLessThanOrEqual(5 * 60_000);
      expect(m.bodyHash).toBe(sha256Hex(`POST ${p} ${sha256Hex(JSON.stringify(h.body))}`));
      expect(recoverPersonalSigner(text, h.headers["x-capstan-signature"] as Hex)?.toLowerCase()).toBe(agent);
    }
    // still one key: the order path never needed it
    expect(s.hits.filter((h) => h.path === "/v1/account/keys").length).toBe(1);
    expect(wallet.prompts.length).toBe(3);

    // the gate is the real one: the same signed request replayed is refused (nonce used once)
    const last = s.hits.filter((x) => x.path === "/v1/orders/build").at(-1)!;
    const replay = await fetch(`${new URL(s.apiBase).origin}/v1/orders/build`, { method: "POST", headers: { "content-type": "application/json", "x-capstan-message": last.headers["x-capstan-message"]!, "x-capstan-signature": last.headers["x-capstan-signature"]! }, body: JSON.stringify(last.body) });
    expect(replay.status).toBe(401);
    // and a request with no auth at all is refused
    const bare = await fetch(`${new URL(s.apiBase).origin}/v1/orders/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(last.body) });
    expect(bare.status).toBe(401);
  });

  test("configured-key-and-no-key", async () => {
    // a configured key goes on every call and no anonymous key is made
    const s = await gated();
    const first = await (await fetch(`${new URL(s.apiBase).origin}/v1/account/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: null }) })).json();
    const { client } = await sdkClient(s, { extra: { apiKey: first.key } });
    await client.onboard("hyperliquid");
    expect(s.hits.filter((h) => h.path === "/v1/account/keys").length).toBe(1); // only the one this test made
    const onb = s.hits.filter((x) => x.path.startsWith("/v1/onboarding/"));
    expect(onb.length).toBeGreaterThanOrEqual(3); // pin setup build, then the SDK's preflight, build and submit
    expect(onb.filter((h) => h.headers.authorization === `Bearer ${first.key}`).map((h) => h.path)).toEqual(["/v1/onboarding/preflight", "/v1/onboarding/build", "/v1/onboarding/submit"]);

    // no key and no anonymous key: the real gate refuses the onboarding build, before any wallet prompt
    const s2 = await gated();
    const { client: c2, wallet: wallet2, ks } = await sdkClient(s2, { extra: { anonymousApiKey: false } });
    const w2 = wallet2 as TestWallet;
    const e = (await c2.onboard("hyperliquid").catch((x) => x)) as SdkError;
    expect(e).toBeInstanceOf(SdkError);
    expect([e.code, e.status]).toEqual(["API_ERROR", 401]);
    expect(w2.prompts).toEqual([]);
    expect(await ks.list()).toEqual([]);
  });
});
