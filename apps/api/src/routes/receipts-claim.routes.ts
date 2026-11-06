// POST /v1/receipts/claim (spec 7.3 direct mode, 13.1): the SDK posted a signed payload to the venue itself and now
// claims the receipt. The claimed envelope must hash-match the stored build and pass the adapter's verifySigned; an
// unknown build or a different payload is refused; a second claim for one build returns the first receipt.
import type { RouteSpec } from "@capstan/core";
import { CapstanError, errorBody, ReceiptClaimZ, type SignedEnvelope } from "@capstan/schema";
import type { Context } from "hono";
import { ordersEnvDeps, type OrdersRouteDeps } from "./orders.routes";

export function createClaimRoutes(getDeps: () => Promise<Pick<OrdersRouteDeps, "claim">> | Pick<OrdersRouteDeps, "claim">): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/receipts/claim",
      auth: "owner_sig",
      authAlt: ["api_key"],
      description: "Claim the receipt for an order you sent to the venue directly",
      write: { action: "order", venue: (_c, body) => ((body as { signedEnvelope?: { venue?: string } } | null)?.signedEnvelope?.venue as string | undefined) ?? null },
      async handler(c: Context) {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json(errorBody("INVALID_INPUT", "body must be JSON"), 400);
        }
        const parsed = ReceiptClaimZ.safeParse(body);
        if (!parsed.success) return c.json(errorBody("INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")), 400);
        const deps = await getDeps();
        try {
          const r = await deps.claim({ buildId: parsed.data.buildId, signedEnvelope: parsed.data.signedEnvelope as SignedEnvelope, venueResponse: parsed.data.venueResponse });
          return c.json(r);
        } catch (e) {
          if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
          throw e;
        }
      },
    },
  ];
}

export const routes: RouteSpec[] = createClaimRoutes(() => ordersEnvDeps());
