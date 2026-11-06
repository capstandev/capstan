// Found on the fork run (todo 40): when the API refused the anonymous key request (429 under its per-IP write limit),
// the SDK sent onboarding without a key and reported the server's "owner signature missing". It now surfaces the
// refusal itself, and the next call tries for a key again.
import { describe, expect, test } from "bun:test";
import { SdkError } from "../src/errors";
import { sdkClient, startStack } from "./stack";

describe("anonymous key refusal", () => {
  test("rate-limit-surfaces", async () => {
    const s = await startStack({ gate: true });
    try {
      let refuse = true;
      const base = globalThis.fetch;
      const f = (async (u: string | URL | Request, init?: RequestInit) => {
        if (refuse && String(u).endsWith("/v1/account/keys")) return Response.json({ error: { code: "RATE_LIMITED", message: "Too many requests." } }, { status: 429 });
        return base(u, init);
      }) as typeof fetch;
      const { client } = await sdkClient(s, { extra: { fetch: f } });
      const e = (await client.onboard("hyperliquid").catch((x) => x)) as SdkError;
      expect(e).toBeInstanceOf(SdkError);
      expect(e.status).toBe(429);
      expect(e.message).toBe("Too many requests.");
      refuse = false;
      expect((await client.onboard("hyperliquid")).agentActive).toBe(true);
    } finally {
      s.stop();
    }
  });
});
