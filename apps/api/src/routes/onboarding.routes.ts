// Onboarding (spec 7.1, 13.1). Every payload here is for the MAIN wallet to sign on the client; nothing accepts a key.
// GET  /v1/onboarding/preflight?venue=&owner=  agent slots, builder approval, the owner's current delegations
// POST /v1/onboarding/build   the venue's bundle (agent approval, builder approval, declaration, optional policy);
//                             stored in onboarding_sessions as 'built' for 10 minutes
// POST /v1/onboarding/submit  by bundleId: refuses unknown, expired or already submitted bundles; the adapter submits;
//                             stores the delegation (PUBLIC data only) and retires every earlier delegation the new
//                             one replaces (spec 4.1 agent replay); issues an onboarding.complete receipt.
import { createDb, schema, type Db, type RouteSpec } from "@capstan/core";
import { capstanAgentName } from "@capstan/adapter-hyperliquid";
import { drafts, type ReceiptDraft } from "@capstan/receipts";
import { sha256Jcs } from "@capstan/relay";
import { AgentPolicyZ, CapstanError, errorBody, OnboardingBuildZ, OnboardingPreflightQueryZ, OnboardingSubmitZ, type Hex, type OnboardingBundle, type OnboardingRequest, type VenueId } from "@capstan/schema";
import { recordOnboardingPrompt } from "@capstan/telemetry";
import { edgeScopeMatches, storeDeclaration } from "@capstan/eligibility";
import { and, eq, ne } from "drizzle-orm";
import type { Context } from "hono";
import { bundleOfRow, type BuildAdapter } from "../adapters";

export const SESSION_LIFE_MS = 10 * 60_000;

export interface OnboardingRouteDeps {
  db: Db;
  adapters: Map<VenueId, BuildAdapter>;
  issue: (d: ReceiptDraft) => Promise<{ receiptId: string }>;
  /** Venue facts for preflight (HL agent slots and builder approval); null when the venue has no public read. */
  venueChecks?: (venue: VenueId, owner: Hex) => Promise<Record<string, unknown> | null>;
  now: () => number;
}

type DelegationRow = typeof schema.delegations.$inferSelect;
interface NewDelegation {
  id: string;
  venue: VenueId;
  owner: string;
  agentAddress: string | null;
  accountIndex: number | null;
  apiKeyIndex: number | null;
}

/** Does the new delegation replace an earlier one at the venue (so the earlier key's envelopes must be refused)? */
export function replaces(old: Pick<DelegationRow, "venue" | "agentAddress" | "accountIndex" | "apiKeyIndex">, next: NewDelegation): boolean {
  if (old.venue !== next.venue) return false;
  if (next.venue === "hyperliquid") return !!old.agentAddress && !!next.agentAddress && capstanAgentName(old.agentAddress as Hex) === capstanAgentName(next.agentAddress as Hex);
  if (next.venue === "lighter-mainnet" || next.venue === "lighter-rh") return old.accountIndex === next.accountIndex && old.apiKeyIndex === next.apiKeyIndex;
  if (next.venue === "aster") return true; // every Capstan Aster agent carries the one agent name ASTER_AGENT_NAME
  return false;
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ");
const ctxGet = (c: Context, k: string): unknown => (c as unknown as { get(k: string): unknown }).get(k);
const isUnique = (e: unknown) => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === "23505" || x?.cause?.code === "23505";
};

async function json(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function createOnboardingRoutes(getDeps: () => Promise<OnboardingRouteDeps> | OnboardingRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/onboarding/preflight",
      auth: "public",
      description: "What onboarding on a venue needs for this wallet: free agent slots, builder approval, current agents",
      async handler(c) {
        const q = OnboardingPreflightQueryZ.safeParse(c.req.query());
        if (!q.success) return c.json(errorBody("INVALID_INPUT", issues(q.error)), 400);
        const deps = await getDeps();
        const venue = q.data.venue as VenueId;
        const owner = q.data.owner.toLowerCase() as Hex;
        const a = deps.adapters.get(venue);
        if (!a) return c.json(errorBody("UNSUPPORTED_VENUE"), 400);
        const rows = await deps.db.select().from(schema.delegations).where(and(eq(schema.delegations.owner, owner), eq(schema.delegations.venue, venue)));
        const checks = deps.venueChecks ? await deps.venueChecks(venue, owner).catch(() => null) : null;
        return c.json({ venue, owner, execution: a.caps.execution, agents: rows.map((r) => ({ agentRef: r.id, state: r.state, agentAddress: r.agentAddress, expiresAt: r.expiresAt?.toISOString() ?? null })), ...(checks ?? {}) });
      },
    },
    {
      method: "POST",
      path: "/onboarding/build",
      auth: "owner_sig",
      authAlt: ["api_key"],
      description: "Build the onboarding steps your main wallet signs (agent approval, builder fee approval, declaration)",
      write: { action: "onboarding" },
      async handler(c) {
        const body = await json(c);
        const p = OnboardingBuildZ.safeParse(body);
        if (!p.success) return c.json(errorBody("INVALID_INPUT", issues(p.error)), 400);
        // an agent-safe policy is checked here, so a malformed one is the caller's 400, never a 500 from the step
        if (p.data.policy !== undefined) {
          const pz = AgentPolicyZ.safeParse(p.data.policy);
          if (!pz.success) return c.json(errorBody("INVALID_INPUT", `policy: ${issues(pz.error)}`), 400);
        }
        const deps = await getDeps();
        const authed = ctxGet(c, "owner");
        if (typeof authed === "string" && authed.toLowerCase() !== p.data.owner.toLowerCase()) return c.json(errorBody("UNAUTHORIZED", "The signature does not belong to this owner."), 401);
        const venue = p.data.venue as VenueId;
        if (!edgeScopeMatches(c, venue, null)) return c.json(errorBody("INVALID_INPUT", "Eligibility was decided for another venue."), 400);
        const a = deps.adapters.get(venue);
        if (!a) return c.json(errorBody("UNSUPPORTED_VENUE"), 400);
        if (!a.caps.execution) {
          const r = await deps.issue(drafts.refusal({ requestHash: sha256Jcs({ route: "/onboarding/build", body: body ?? null, code: "VENUE_DATA_ONLY" }), eligibilityDecisionId: String(ctxGet(c, "eligibilityDecisionId") ?? "onboarding:VENUE_DATA_ONLY"), owner: ctxGet(c, "ownerAuthed") === true ? (p.data.owner.toLowerCase() as Hex) : null, venue })).catch(() => null);
          return c.json(errorBody("VENUE_DATA_ONLY", undefined, r?.receiptId), 403);
        }
        const req: OnboardingRequest & Record<string, unknown> = {
          venue,
          owner: p.data.owner as Hex,
          ...(p.data.agentAddress ? { agentAddress: p.data.agentAddress as Hex } : {}),
          ...(p.data.lighterPubKey ? { lighterPubKey: p.data.lighterPubKey } : {}),
          ...(p.data.builderMaxBps !== undefined ? { builderMaxBps: p.data.builderMaxBps } : {}),
          ...(p.data.policy !== undefined ? { policy: p.data.policy } : {}),
          // Aster relay or direct mode and the direct-mode IP whitelist (public facts)
          ...(typeof body!.mode === "string" ? { mode: body!.mode } : {}),
          ...(typeof body!.directIp === "string" ? { directIp: body!.directIp } : {}),
        };
        let b: OnboardingBundle;
        try {
          b = await a.buildOnboarding(req);
        } catch (e) {
          if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
          throw e;
        }
        const stored = { bundle: b, request: { venue, owner: req.owner.toLowerCase(), agentAddress: req.agentAddress?.toLowerCase() ?? null, policy: req.policy ?? null } };
        await deps.db
          .insert(schema.onboardingSessions)
          .values({ id: b.bundleId, venue, owner: req.owner.toLowerCase(), bundle: stored, templateHash: b.templateHash, status: "built", createdAt: new Date(deps.now()) })
          .onConflictDoUpdate({ target: schema.onboardingSessions.id, set: { bundle: stored, status: "built" } });
        // each step is one wallet prompt the owner will see
        for (let i = 0; i < b.steps.length; i++) recordOnboardingPrompt("shown");
        return c.json(b);
      },
    },
    {
      method: "POST",
      path: "/onboarding/submit",
      auth: "owner_sig",
      authAlt: ["api_key"],
      description: "Submit the signed onboarding steps; the venue records the agent and the builder approval",
      write: {
        action: "onboarding",
        async venue(_c, body) {
          const id = (body as { bundleId?: unknown } | null)?.bundleId;
          if (typeof id !== "string") return null;
          const deps = await getDeps();
          const [r] = await deps.db.select({ venue: schema.onboardingSessions.venue }).from(schema.onboardingSessions).where(eq(schema.onboardingSessions.id, id)).limit(1);
          return r?.venue ?? "hyperliquid";
        },
        // the bundle's owner (an API-key submit names none): the edge checks that owner's region and the handler
        // stores that owner's signed declaration
        async owner(_c, body) {
          const id = (body as { bundleId?: unknown } | null)?.bundleId;
          if (typeof id !== "string") return null;
          const deps = await getDeps();
          const [r] = await deps.db.select({ owner: schema.onboardingSessions.owner }).from(schema.onboardingSessions).where(eq(schema.onboardingSessions.id, id)).limit(1);
          return r?.owner ?? null;
        },
      },
      async handler(c) {
        const body = await json(c);
        const p = OnboardingSubmitZ.safeParse(body);
        if (!p.success) return c.json(errorBody("INVALID_INPUT", issues(p.error)), 400);
        const deps = await getDeps();
        const s = schema.onboardingSessions;
        const [row] = await deps.db.select().from(s).where(eq(s.id, p.data.bundleId)).limit(1);
        if (!row) return c.json(errorBody("NOT_FOUND", "Unknown onboarding bundle."), 404);
        const authed = ctxGet(c, "owner");
        if (typeof authed === "string" && authed.toLowerCase() !== row.owner.toLowerCase()) return c.json(errorBody("UNAUTHORIZED", "The signature does not belong to this bundle's owner."), 401);
        if (row.status !== "built") return c.json(errorBody("INVALID_INPUT", "This onboarding bundle was already submitted."), 409);
        const bundle = bundleOfRow(row.bundle);
        const request = ((row.bundle as { request?: { agentAddress?: string | null } }).request ?? {}) as { agentAddress?: string | null };
        const now = deps.now();
        if (now > row.createdAt.getTime() + SESSION_LIFE_MS || now > bundle.expiresAt) {
          await deps.db.update(s).set({ status: "expired" }).where(eq(s.id, row.id));
          return c.json(errorBody("BUILD_EXPIRED", "This onboarding bundle has expired. Build it again."), 410);
        }
        // one submit per bundle: only the request that moves 'built' to 'submitted' goes on
        const claimed = await deps.db.update(s).set({ status: "submitted" }).where(and(eq(s.id, row.id), eq(s.status, "built"))).returning({ id: s.id });
        if (!claimed.length) return c.json(errorBody("INVALID_INPUT", "This onboarding bundle was already submitted."), 409);
        const venue = row.venue as VenueId;
        const a = deps.adapters.get(venue);
        if (!a) return c.json(errorBody("UNSUPPORTED_VENUE"), 400);
        // the signed eligibility declaration (spec 10 item 2) is verified and stored before any venue step is sent;
        // later writes find it (the edge refuses orders without it)
        const di = bundle.steps.findIndex((st) => st.kind === "eligibility_declaration" && st.typedData);
        if (di >= 0) {
          const sig = (p.data.signatures as { step: number; sig: Hex }[]).find((x) => x.step === di)?.sig;
          try {
            if (!sig) throw new CapstanError("DECLARATION_MISSING", "The eligibility declaration step is not signed.");
            const td = bundle.steps[di]!.typedData!;
            if (String((td.message as { owner?: unknown }).owner ?? "").toLowerCase() !== row.owner.toLowerCase()) throw new CapstanError("UNAUTHORIZED", "The declaration names another owner.");
            await storeDeclaration(td, sig, deps.db, now);
          } catch (e) {
            await deps.db.update(s).set({ status: "failed" }).where(eq(s.id, row.id));
            if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
            throw e;
          }
        }
        let res;
        try {
          res = await a.submitOnboarding({ bundleId: row.id, signatures: p.data.signatures as { step: number; sig: Hex }[], ...(p.data.lighterSignedTx !== undefined ? { lighterSignedTx: p.data.lighterSignedTx } : {}) });
        } catch (e) {
          await deps.db.update(s).set({ status: "failed" }).where(eq(s.id, row.id));
          if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
          throw e;
        }
        const [, acct, key] = venue.startsWith("lighter") ? res.agentRef.split(":") : [];
        const next: NewDelegation = {
          id: res.agentRef,
          venue,
          owner: row.owner.toLowerCase(),
          agentAddress: request.agentAddress ?? null,
          accountIndex: acct !== undefined && /^\d+$/.test(acct) ? Number(acct) : null,
          apiKeyIndex: key !== undefined && /^\d+$/.test(key) ? Number(key) : null,
        };
        try {
          await deps.db.transaction(async (tx) => {
            await tx.insert(schema.delegations).values({ ...next, builderMaxBps: res.delegation.builderMaxBps, expiresAt: res.delegation.expiresAt ? new Date(res.delegation.expiresAt) : null, state: "active", createdAt: new Date(now) });
            const earlier = await tx.select().from(schema.delegations).where(and(eq(schema.delegations.owner, next.owner), eq(schema.delegations.venue, venue), eq(schema.delegations.state, "active"), ne(schema.delegations.id, next.id)));
            for (const d of earlier) if (replaces(d, next)) await tx.update(schema.delegations).set({ state: "retired" }).where(eq(schema.delegations.id, d.id));
          });
        } catch (e) {
          if (isUnique(e)) {
            await deps.db.update(s).set({ status: "failed" }).where(eq(s.id, row.id));
            return c.json(errorBody("INVALID_INPUT", "This agent was used before. Make a new key and onboard again."), 409);
          }
          throw e;
        }
        const receipt = await deps.issue(drafts.onboardingComplete({ owner: next.owner as Hex, venue, agentRef: next.id, requestHash: sha256Jcs(body), eligibilityDecisionId: String(ctxGet(c, "eligibilityDecisionId") ?? ""), policyId: res.delegation.policyId ?? null }));
        await deps.db.update(s).set({ status: "complete" }).where(eq(s.id, row.id));
        for (let i = 0; i < p.data.signatures.length; i++) recordOnboardingPrompt("signed");
        return c.json({ agentRef: next.id, delegation: res.delegation, receiptId: receipt.receiptId });
      },
    },
  ];
}

let resolved: Promise<OnboardingRouteDeps> | null = null;
async function envDeps(): Promise<OnboardingRouteDeps> {
  const env = process.env;
  if (!env.DATABASE_URL || !env.REDIS_URL) throw new CapstanError("INTERNAL_ERROR", "onboarding routes need DATABASE_URL and REDIS_URL");
  const db = createDb(env.DATABASE_URL, { max: 4 });
  const { getAdapters } = await import("../adapters");
  const { adapters } = await getAdapters();
  const { createRedis } = await import("@capstan/core");
  const { queuedReceipts } = await import("@capstan/relay");
  const receipts = queuedReceipts(createRedis(env.REDIS_URL, { forBullmq: true }), db);
  return {
    db,
    adapters,
    issue: async (d) => ({ receiptId: (await receipts.issue(d)).receiptId }),
    async venueChecks(venue, owner) {
      if (venue !== "hyperliquid") return null;
      const hl = adapters.get("hyperliquid") as unknown as { reader: { extraAgents(u: Hex): Promise<unknown[]>; maxBuilderFee(u: Hex, b: Hex): Promise<number> }; caps: { builderFee: { builderAddress: Hex } | null } };
      const agents = await hl.reader.extraAgents(owner);
      const fee = hl.caps.builderFee ? await hl.reader.maxBuilderFee(owner, hl.caps.builderFee.builderAddress) : 0;
      return { slotsFree: Math.max(0, 3 - agents.length), builderApprovedBps: fee / 10 };
    },
    now: Date.now,
  };
}

export const routes: RouteSpec[] = createOnboardingRoutes(() => (resolved ??= envDeps()));
