// POST /v1/receipts/claim (spec 7.3 direct mode, 13.1): the SDK posted a signed payload to the venue itself and now
// claims the receipt. The claimed envelope must hash-match the stored build and pass the adapter's verifySigned; an
// unknown build or a different payload is refused; a second claim for one build returns the first receipt.
import { schema, type Db, type RouteSpec } from "@capstan/core";
import { eq } from "drizzle-orm";
import { CapstanError, errorBody, ReceiptClaimZ, type SignedEnvelope } from "@capstan/schema";
import type { Context } from "hono";
import { ordersEnvDeps, ownerMatches, type OrdersRouteDeps } from "./orders.routes";

type ClaimRouteDeps = Pick<OrdersRouteDeps, "claim"> & { db: Db };
const buildRow = async (deps: ClaimRouteDeps, id: unknown) => {
  if (typeof id !== "string") return null;
  const [r] = await deps.db.select({ owner: schema.orderBuilds.owner, marketId: schema.orderBuilds.marketId }).from(schema.orderBuilds).where(eq(schema.orderBuilds.id, id)).limit(1);
  return r ?? null;
};

export function createClaimRoutes(getDeps: () => Promise<ClaimRouteDeps> | ClaimRouteDeps): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/receipts/claim",
      auth: "owner_sig",
      authAlt: ["api_key"],
      description: "Claim the receipt for an order you sent to the venue directly",
      write: {
        action: "order",
        venue: (_c, body) => ((body as { signedEnvelope?: { venue?: string } } | null)?.signedEnvelope?.venue as string | undefined) ?? null,
        // r1 R1-04: the edge decides for the build's owner and market, never a body owner
        owner: async (_c, body) => (await buildRow(await getDeps(), (body as { buildId?: unknown } | null)?.buildId))?.owner ?? null,
        marketId: async (_c, body) => (await buildRow(await getDeps(), (body as { buildId?: unknown } | null)?.buildId))?.marketId ?? null,
      },
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
        // r1 R1-04: only the build's own owner (its signature or its own API key) may claim it
        const row = await buildRow(deps, parsed.data.buildId);
        if (!row || !ownerMatches(c, row.owner as never)) return c.json(errorBody(row ? "UNAUTHORIZED" : "NOT_FOUND", row ? "The signature does not belong to this build's owner." : "Unknown build."), row ? 401 : 404);
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
