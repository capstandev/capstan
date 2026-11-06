// tel.serve must hand Bun's server argument to the app: Hono's getConnInfo reads the caller's socket address from it,
// and the eligibility edge and the request log read the caller IP that way. Without it every caller has no IP, so
// every write is GEO_REFUSED whenever no trusted X-Forwarded-For header is present (a local stack, a fork run).
import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { initTelemetry } from "../src";

describe("tel.serve", () => {
  const tel = initTelemetry("api", { memory: true });
  const app = new Hono();
  app.get("/ip", (c) => c.text(String(getConnInfo(c).remote.address)));
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: tel.serve(app.fetch) });
  afterAll(() => srv.stop(true));

  test("passes-the-server-to-the-handler", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/ip`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("127.0.0.1");
  });
});
