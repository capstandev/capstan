// x402 facilitator HTTP API (v2): POST /verify, POST /settle, GET /supported, GET /health.
// Status codes: 200 ok, 202 settlement_pending, 400 malformed, 402 refused, 403 mainnet settle not armed,
// 412 permit2_allowance_required, 500 unexpected.
import { Hono } from "hono";
import type { FacilitatorService } from "./service";

export function createFacilitatorApp(svc: FacilitatorService): Hono {
  const app = new Hono();
  const body = async (c: { req: { json(): Promise<unknown> } }): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  };
  app.post("/verify", async (c) => {
    const r = await svc.verify(await body(c));
    return c.json(r.body, r.status as 200);
  });
  app.post("/settle", async (c) => {
    const r = await svc.settle(await body(c));
    return c.json(r.body, r.status as 200);
  });
  app.get("/supported", (c) => c.json(svc.supported()));
  app.get("/health", (c) => c.json({ ok: true }));
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((_e, c) => c.json({ error: "internal error" }, 500));
  return app;
}
