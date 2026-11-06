// R13, R16, R17 (todo 29): onboarding submit stores delegations with public data only and refuses a reused agent
// address; a submit refuses an unknown, expired or already submitted bundle; completing onboarding retires every
// earlier active delegation the new one replaces (HL same agent name, Lighter same account and key index, Aster same
// agent name). The adapters are stubs here (each adapter tests its own bundles); the route logic is what runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, ulid, type Db } from "@capstan/core";
import type { Hex, OnboardingBundle, OnboardingRequest, SignedOnboarding, VenueId } from "@capstan/schema";
import { and, eq, sql } from "drizzle-orm";
import type { BuildAdapter } from "../src/adapters";
import { createOnboardingRoutes, replaces, SESSION_LIFE_MS } from "../src/routes/onboarding.routes";
import { smallApp, T } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const d = PG ? describe : describe.skip;
const OWNER = "0x00000000000000000000000000000000000000a1" as Hex;
const SIG = `0x${"11".repeat(65)}`;

function stub(venue: VenueId, agentRefOf: (req: OnboardingRequest & Record<string, unknown>) => string, now: () => number): BuildAdapter {
  const reqs = new Map<string, OnboardingRequest & Record<string, unknown>>();
  return {
    caps: { venue, execution: true },
    async buildOnboarding(req: OnboardingRequest & Record<string, unknown>): Promise<OnboardingBundle> {
      const b: OnboardingBundle = { bundleId: ulid(), venue, owner: req.owner, steps: [{ kind: "eligibility_declaration", signer: "main_wallet" }], humanReadable: ["Sign the declaration."], templateHash: "0x01", expiresAt: now() + SESSION_LIFE_MS };
      reqs.set(b.bundleId, req);
      return b;
    },
    async submitOnboarding(s: SignedOnboarding) {
      return { agentRef: agentRefOf(reqs.get(s.bundleId)!), delegation: { agentActive: true, builderMaxBps: 3, routing: "ok" as const }, venueResponses: [] };
    },
  } as unknown as BuildAdapter;
}

d("onboarding routes", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let now = T;
  let app: Awaited<ReturnType<typeof smallApp>>["app"];
  const receipts: string[] = [];
  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_onboarding" });
    db = createDb(tmp.url, { max: 6 });
    const adapters = new Map<VenueId, BuildAdapter>([
      ["hyperliquid", stub("hyperliquid", (r) => `hl:${String(r.agentAddress).toLowerCase()}`, () => now)],
      ["lighter-mainnet", stub("lighter-mainnet", (r) => `lighter-mainnet:712:${String(r.lighterPubKey).endsWith("05") ? 5 : 6}`, () => now)],
      ["aster", stub("aster", (r) => `aster:${r.owner.toLowerCase()}:${String(r.agentAddress).toLowerCase()}`, () => now)],
    ]);
    ({ app } = await smallApp(createOnboardingRoutes(() => ({ db, adapters, issue: async () => (receipts.push(`r${receipts.length}`), { receiptId: `r${receipts.length - 1}` }), now: () => now })), { verifiers: { owner_sig: () => null, api_key: () => null } }));
  }, 60_000);
  afterAll(async () => {
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  const post = (path: string, body: unknown) => app.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const build = async (body: Record<string, unknown>) => (await (await post("/onboarding/build", { owner: OWNER, ...body })).json()) as OnboardingBundle;
  const submit = (bundleId: string) => post("/onboarding/submit", { bundleId, signatures: [{ step: 0, sig: SIG }] });
  const row = async (id: string) => (await db.select().from(schema.delegations).where(eq(schema.delegations.id, id)))[0];

  test("public-only-and-unique", async () => {
    // the delegations table has no key-shaped column at all
    const cols = (await db.execute(sql`select column_name from information_schema.columns where table_name = 'delegations'`)) as unknown as { column_name: string }[];
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(["account_index", "agent_address", "api_key_index", "builder_max_bps", "created_at", "expires_at", "id", "owner", "state", "venue"]);
    const agent = "0x00000000000000000000000000000000000000b1";
    const b = await build({ venue: "hyperliquid", agentAddress: agent });
    const r = await submit(b.bundleId);
    expect(r.status).toBe(200);
    const out = (await r.json()) as { agentRef: string; receiptId: string };
    expect(out.receiptId).toBeDefined();
    const dg = await row(out.agentRef);
    expect(dg).toMatchObject({ venue: "hyperliquid", owner: OWNER.toLowerCase(), agentAddress: agent, state: "active", builderMaxBps: 3 });
    // the same agent address again (a fresh bundle): refused by the unique index, nothing stored
    const again = await build({ venue: "hyperliquid", agentAddress: agent });
    const r2 = await submit(again.bundleId);
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { error: { message: string } }).error.message).toContain("used before");
    expect((await db.select().from(schema.delegations).where(eq(schema.delegations.agentAddress, agent))).length).toBe(1);
  });

  test("session-lifecycle", async () => {
    expect((await submit("01JNOSUCHBUNDLE00000000000")).status).toBe(404);
    // already submitted
    const b = await build({ venue: "hyperliquid", agentAddress: "0x00000000000000000000000000000000000000b2" });
    expect((await submit(b.bundleId)).status).toBe(200);
    expect((await submit(b.bundleId)).status).toBe(409);
    // two at once: exactly one goes on
    const c = await build({ venue: "hyperliquid", agentAddress: "0x00000000000000000000000000000000000000b3" });
    const both = await Promise.all([submit(c.bundleId), submit(c.bundleId)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    // expired: 10 minutes of life
    const e = await build({ venue: "hyperliquid", agentAddress: "0x00000000000000000000000000000000000000b4" });
    now += SESSION_LIFE_MS + 1;
    expect((await submit(e.bundleId)).status).toBe(410);
    expect((await db.select().from(schema.onboardingSessions).where(eq(schema.onboardingSessions.id, e.bundleId)))[0]!.status).toBe("expired");
    now = T;
  });

  test("previous-retired", async () => {
    // Lighter: the same account and API key index replaces the earlier key
    const l1 = await build({ venue: "lighter-mainnet", lighterPubKey: "0x05" });
    const a1 = ((await (await submit(l1.bundleId)).json()) as { agentRef: string }).agentRef;
    expect(a1).toBe("lighter-mainnet:712:5");
    await db.update(schema.delegations).set({ id: "lighter-mainnet:712:5:old" }).where(eq(schema.delegations.id, a1)); // keep the earlier row under its own id
    const l2 = await build({ venue: "lighter-mainnet", lighterPubKey: "0x05" });
    expect((await submit(l2.bundleId)).status).toBe(200);
    expect((await row("lighter-mainnet:712:5:old"))!.state).toBe("retired");
    expect((await row("lighter-mainnet:712:5"))!.state).toBe("active");
    // another key index is not replaced
    const l3 = await build({ venue: "lighter-mainnet", lighterPubKey: "0x06" });
    expect((await submit(l3.bundleId)).status).toBe(200);
    expect((await row("lighter-mainnet:712:5"))!.state).toBe("active");
    // Aster: every Capstan agent carries one agent name, so a new agent retires the earlier one
    const s1 = await build({ venue: "aster", agentAddress: "0x00000000000000000000000000000000000000c1" });
    const ar1 = ((await (await submit(s1.bundleId)).json()) as { agentRef: string }).agentRef;
    const s2 = await build({ venue: "aster", agentAddress: "0x00000000000000000000000000000000000000c2" });
    const ar2 = ((await (await submit(s2.bundleId)).json()) as { agentRef: string }).agentRef;
    expect((await row(ar1))!.state).toBe("retired");
    expect((await row(ar2))!.state).toBe("active");
    // Hyperliquid: agent names come from the agent address, so only the same name is replaced
    const active = await db.select().from(schema.delegations).where(and(eq(schema.delegations.venue, "hyperliquid"), eq(schema.delegations.state, "active")));
    expect(active.length).toBeGreaterThanOrEqual(2); // different agents, different names: both stay
    const same = { venue: "hyperliquid" as VenueId, agentAddress: "0x00000000000000000000000000000000000000d9", accountIndex: null, apiKeyIndex: null };
    expect(replaces(same, { ...same, id: "x", owner: OWNER })).toBe(true);
    expect(replaces(same, { ...same, agentAddress: "0x00000000000000000000000000000000000000da", id: "y", owner: OWNER })).toBe(false);
    expect(replaces({ ...same, venue: "aster" }, { ...same, id: "z", owner: OWNER })).toBe(false); // other venue
  });
});
