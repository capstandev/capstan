// The API fails a venue budget wait fast with 429 VENUE_RATE_LIMITED and Retry-After (gate-r4 G4-01). The SDK waits
// the server's delay and sends again, a bounded number of times, and never past the caller's deadline (a relay
// submit's build expiry). A server or relay POLICY_BREACH reaches the caller as POLICY_BREACH, not API_ERROR.
import { afterEach, describe, expect, test } from "bun:test";
import type { OrderIntent } from "@capstan/schema";
import { createApi, retryAfterMs, type RateLimitRetry } from "../src/api";
import { SdkError } from "../src/errors";
import { T0 } from "./helpers";
import { sdkClient, startStack } from "./stack";

const limited = (retryAfter: string | null, code = "VENUE_RATE_LIMITED") =>
  new Response(JSON.stringify({ error: { code, message: "The venue rate budget is used up. Try again shortly." } }), {
    status: 429,
    headers: { "content-type": "application/json", ...(retryAfter !== null ? { "retry-after": retryAfter } : {}) },
  });
const ok = () => new Response(JSON.stringify({ fine: true }), { status: 200, headers: { "content-type": "application/json" } });

function harness(answers: Array<() => Response>, retry: RateLimitRetry | false = {}) {
  let t = T0;
  const sleeps: number[] = [];
  const calls: Array<{ url: string; auth: string | null }> = [];
  let i = 0;
  const f = (async (u: string, init?: RequestInit) => {
    calls.push({ url: u, auth: new Headers(init?.headers).get("x-test-auth") });
    return answers[Math.min(i++, answers.length - 1)]!();
  }) as unknown as typeof fetch;
  let auths = 0;
  const api = createApi("http://127.0.0.1:1", f, { retry: retry === false ? false : { sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, ...retry } });
  return { api, sleeps, calls, auth: async () => ({ "x-test-auth": `a${++auths}` }) };
}
const caught = async (p: Promise<unknown>): Promise<SdkError> => {
  try {
    await p;
  } catch (e) {
    return e as SdkError;
  }
  throw new Error("expected a throw");
};

describe("VENUE_RATE_LIMITED retry", () => {
  test("waits the server's Retry-After and sends again, with fresh auth headers", async () => {
    const h = harness([() => limited("2"), ok]);
    expect(await h.api.post("/orders/submit", { x: 1 }, { auth: h.auth })).toEqual({ fine: true });
    expect(h.sleeps).toEqual([2_000]);
    expect(h.calls.map((c) => c.auth)).toEqual(["a1", "a2"]);
  });
  test("GET retries too", async () => {
    const h = harness([() => limited("1"), ok]);
    expect(await h.api.get("/markets")).toEqual({ fine: true });
    expect(h.sleeps).toEqual([1_000]);
  });
  test("bounded: after maxRetries the 429 reaches the caller with retryAfterMs", async () => {
    const h = harness([() => limited("1")]);
    const e = await caught(h.api.get("/markets"));
    expect([e.code, e.serverCode, e.status, e.retryAfterMs]).toEqual(["API_ERROR", "VENUE_RATE_LIMITED", 429, 1_000]);
    expect(h.calls.length).toBe(3);
    expect(h.sleeps).toEqual([1_000, 1_000]);
  });
  test("never waits past the total wait budget", async () => {
    const h = harness([() => limited("6")], { maxRetries: 5, maxWaitMs: 10_000 });
    const e = await caught(h.api.get("/markets"));
    expect(h.sleeps).toEqual([6_000]);
    expect(e.retryAfterMs).toBe(6_000);
  });
  test("never waits past the caller's deadline", async () => {
    const h = harness([() => limited("3"), ok]);
    const e = await caught(h.api.post("/orders/submit", {}, { deadline: T0 + 2_500 }));
    expect([e.serverCode, e.retryAfterMs]).toEqual(["VENUE_RATE_LIMITED", 3_000]);
    expect(h.sleeps).toEqual([]);
    expect(h.calls.length).toBe(1);
    const h2 = harness([() => limited("2"), ok]);
    expect(await h2.api.post("/orders/submit", {}, { deadline: T0 + 2_500 })).toEqual({ fine: true });
  });
  test("no Retry-After, another 429 code, or retries off: no retry", async () => {
    for (const [h, code] of [
      [harness([() => limited(null), ok]), "VENUE_RATE_LIMITED"],
      [harness([() => limited("1", "INTERNAL_ERROR"), ok]), "INTERNAL_ERROR"],
      [harness([() => limited("1"), ok], false), "VENUE_RATE_LIMITED"],
    ] as const) {
      const e = await caught(h.api.get("/markets"));
      expect(e.serverCode).toBe(code);
      expect(h.calls.length).toBe(1);
    }
  });
  test("Retry-After as an HTTP date", () => {
    expect(retryAfterMs(new Date(T0 + 4_000).toUTCString(), T0)).toBe(4_000);
    expect(retryAfterMs("soon", T0)).toBeNull();
    expect(retryAfterMs(null, T0)).toBeNull();
  });
});

describe("server POLICY_BREACH", () => {
  test("the relay's refusal is POLICY_BREACH with the field, server code, status and receipt", async () => {
    const body = { error: { code: "POLICY_BREACH", message: "The request breaches the agent policy (maxGrossNotionalUsd).", receiptId: "rcpt_1" } };
    const h = harness([() => new Response(JSON.stringify(body), { status: 403 })]);
    const e = await caught(h.api.post("/orders/submit", {}));
    expect(e).toBeInstanceOf(SdkError);
    expect([e.code, e.field, e.serverCode, e.status, e.receiptId]).toEqual(["POLICY_BREACH", "maxGrossNotionalUsd", "POLICY_BREACH", 403, "rcpt_1"]);
  });
  test("other server codes stay API_ERROR", async () => {
    const h = harness([() => new Response(JSON.stringify({ error: { code: "AGENT_KILLED", message: "stopped" } }), { status: 403 })]);
    const e = await caught(h.api.post("/orders/submit", {}));
    expect([e.code, e.serverCode]).toEqual(["API_ERROR", "AGENT_KILLED"]);
  });
});

describe("client relay submit", () => {
  const stacks: Awaited<ReturnType<typeof startStack>>[] = [];
  afterEach(() => {
    while (stacks.length) stacks.pop()!.stop();
  });
  const BUY: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
  const setup = async (retryAfter: string) => {
    const s = await startStack();
    stacks.push(s);
    const sleeps: number[] = [];
    let first = true;
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = u instanceof Request ? u.url : String(u);
      if (first && url.endsWith("/v1/orders/submit")) {
        first = false;
        return limited(retryAfter);
      }
      return fetch(u, init);
    }) as typeof fetch;
    const { client } = await sdkClient(s, { extra: { fetch: f, rateLimitRetry: { maxWaitMs: 120_000, sleep: async (ms) => void sleeps.push(ms) } } });
    await client.onboard("hyperliquid");
    return { s, client, sleeps };
  };
  test("a 429 on submit is retried with the same signed body and the order goes through", async () => {
    const { s, client, sleeps } = await setup("1");
    const r = await client.signAndSubmit(await client.buildOrder(BUY, "hyperliquid", "relay"));
    expect(sleeps).toEqual([1_000]);
    expect(r.receiptId).toBeTruthy();
    expect(s.hits.filter((h) => h.path === "/v1/orders/submit").length).toBe(1);
  });
  test("a Retry-After past the build's expiry is not waited out", async () => {
    const { client, sleeps } = await setup("60");
    const e = await caught(client.signAndSubmit(await client.buildOrder(BUY, "hyperliquid", "relay")));
    expect([e.serverCode, e.retryAfterMs]).toEqual(["VENUE_RATE_LIMITED", 60_000]);
    expect(sleeps).toEqual([]);
  });
});
