// POST /v1/credits/topup/{5,20,100}?account=<id> (x402): buy a pack of premium-call credits; the credit lands once the
// payment settles (the resource server's after-settle hook, topupSettleHook, reads the served path and ?account= from
// the HTTP transport context, never the client's resource.url, and calls topUpCredits once per settlement).
// GET /v1/credits (API key): balance and recent ledger entries.
import type { RouteSpec } from "@capstan/core";
import { creditsOf, TOPUP_PACKS, verifyApiKey } from "@capstan/plans";
import { errorBody } from "@capstan/schema";
import { envPlansDeps, presentedKey, type PlansDeps } from "./account.routes";

export function createCreditsRoutes(getDeps: () => Promise<PlansDeps> | PlansDeps): RouteSpec[] {
  const topups: RouteSpec[] = TOPUP_PACKS.map((pack) => ({
    method: "POST" as const,
    path: `/credits/topup/${pack}`,
    auth: "x402" as const,
    priced: { usd: pack },
    description: `Buy $${pack} of premium-call credits`,
    async handler(c) {
      const d = await getDeps();
      // exactly one ?account= (the after-settle hook credits the same single value; a repeat is refused before paying)
      const all = c.req.queries("account") ?? [];
      const account = all.length === 1 ? all[0]! : "";
      if (!account) return c.json(errorBody("INVALID_INPUT", "exactly one account query parameter is required"), 400);
      const known = await creditsOf(d.db, account, 0);
      if (!known) return c.json(errorBody("NOT_FOUND", "unknown account"), 404);
      return c.json({ account, pack, status: "credited when the payment settles" }, 202);
    },
  }));
  return [
    ...topups,
    {
      method: "GET",
      path: "/credits",
      auth: "api_key",
      description: "Your premium-call credit balance",
      async handler(c) {
        const d = await getDeps();
        const key = presentedKey(c);
        const acct = key ? await verifyApiKey(d.db, key) : null;
        if (!acct) return c.json(errorBody("UNAUTHORIZED"), 401);
        const r = await creditsOf(d.db, acct.id);
        return c.json(r ?? { credits: "0", ledger: [] });
      },
    },
  ];
}

export const routes: RouteSpec[] = createCreditsRoutes(envPlansDeps);
