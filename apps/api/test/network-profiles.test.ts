// Network profiles: on local and testnet every venue that has a testnet reads its testnet host in every process role
// (api adapters, relay venues, catalog sources, ingest readers, account readers), and Variational, which has no
// testnet, reads mainnet and is marked mainnetReadOnly in /v1/venues. On mainnet nothing reads a testnet host.
// Hosts are taken from the real requests: fetch is swapped for a recorder that answers 404 to everything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHlRuntime } from "@capstan/adapter-hyperliquid";
import { defaultAsterReader } from "@capstan/adapter-aster";
import { defaultArcusAdapter } from "@capstan/adapter-arcus";
import { defaultVariationalAdapter } from "@capstan/adapter-variational";
import { lighterConfigsFor, lighterReaderFor } from "@capstan/adapter-lighter";
import { createMemoryGovernor } from "@capstan/venue-client";
import { venueNetworkEntry, type VenueId } from "@capstan/schema";
import { envAccountDeps } from "@capstan/risk";
import { composeAdapters } from "../src/adapters";
import { createVenueRoutes } from "../src/routes/venues.routes";
import { relayVenues } from "../../relay/src/wire";

const TESTNET_HOSTS: Record<string, VenueId> = {
  "api.hyperliquid-testnet.xyz": "hyperliquid",
  "testnet.zklighter.elliot.ai": "lighter-mainnet",
  "api.rh-testnet.lighter.xyz": "lighter-rh",
  "fapi.asterdex-testnet.com": "aster",
  "api.testnet.arcus.xyz": "arcus",
};
const MAINNET_HOSTS: Record<string, VenueId> = {
  "api.hyperliquid.xyz": "hyperliquid",
  "mainnet.zklighter.elliot.ai": "lighter-mainnet",
  "api.rh.lighter.xyz": "lighter-rh",
  "fapi.asterdex.com": "aster",
  "api.arcus.xyz": "arcus",
  "omni-client-api.prod.ap-northeast-1.variational.io": "variational",
};

let hosts: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    hosts.push(u.host);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const attempt = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch {
    /* every answer is 404: only the host matters */
  }
};

/** Every read path a process role builds from the environment, each asked for its markets once. */
async function touchEveryReader(env: Record<string, string | undefined>): Promise<void> {
  const { adapters } = await composeAdapters(env, { db: null, redis: null });
  for (const a of adapters.values()) await attempt(() => (a as { listMarkets(): Promise<unknown> }).listMarkets());
  const relay = await relayVenues({ ...env, CAPSTAN_RUNNER: "vps" }, createMemoryGovernor("t"));
  expect(relay.size).toBeGreaterThan(0);
  await attempt(() => createHlRuntime(env).reader.listMarkets());
  for (const cfg of lighterConfigsFor(env)) await attempt(() => lighterReaderFor(cfg, createMemoryGovernor("t"), null).listMarkets());
  await attempt(() => defaultAsterReader({ env }).listMarkets());
  await attempt(() => defaultArcusAdapter({ env }).listMarkets());
  await attempt(() => defaultVariationalAdapter({ env }).listMarkets());
  const acct = await envAccountDeps(env, { redis: null, cache: null });
  for (const [venue, a] of acct.adapters) await attempt(() => a.getAccount({ venue, owner: "0x0000000000000000000000000000000000000001" }));
}

async function venuesBody(env: Record<string, string | undefined>) {
  const caps = (["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "variational", "arcus"] as VenueId[]).map((venue) => ({ venue, canWithdraw: false as const }));
  const [route] = createVenueRoutes(() => ({ caps: async () => caps as never, env }));
  const res = (await route!.handler({ json: (b: unknown) => b } as never)) as unknown as { venue: VenueId; network: { network: string; mainnetReadOnly: boolean; note: string | null } }[];
  return new Map(res.map((r) => [r.venue, r.network]));
}

describe("network profiles", () => {
  for (const profile of ["local", "testnet"] as const) {
    test(`${profile}-reads-testnet-hosts`, async () => {
      hosts = [];
      const env = { CAPSTAN_NETWORK: profile };
      await touchEveryReader(env);
      const seen = new Set(hosts);
      // every venue with a testnet was reached on its testnet host, and never on its mainnet host
      for (const [h, v] of Object.entries(TESTNET_HOSTS)) expect({ v, h, seen: seen.has(h) }).toEqual({ v, h, seen: true });
      for (const [h, v] of Object.entries(MAINNET_HOSTS)) if (v !== "variational") expect({ v, h, seen: seen.has(h) }).toEqual({ v, h, seen: false });
      // Variational has no testnet: its mainnet host, marked read-only data
      expect(seen.has("omni-client-api.prod.ap-northeast-1.variational.io")).toBe(true);
      const body = await venuesBody(env);
      expect(body.get("variational")).toEqual({ network: "mainnet", mainnetReadOnly: true, note: "No testnet exists for this venue: mainnet market data, read only." });
      for (const v of ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "arcus"] as VenueId[]) expect(body.get(v)).toEqual({ network: "testnet", mainnetReadOnly: false, note: null });
    }, 60_000);
  }

  test("mainnet-reads-mainnet-hosts", async () => {
    hosts = [];
    const env = { CAPSTAN_NETWORK: "mainnet" };
    await touchEveryReader(env);
    const seen = new Set(hosts);
    for (const h of Object.keys(MAINNET_HOSTS)) expect({ h, seen: seen.has(h) }).toEqual({ h, seen: true });
    for (const h of Object.keys(TESTNET_HOSTS)) expect({ h, seen: seen.has(h) }).toEqual({ h, seen: false });
    for (const [, n] of await venuesBody(env)) expect(n).toEqual({ network: "mainnet", mainnetReadOnly: false, note: null });
  }, 60_000);

  test("override-labelled", () => {
    // an operator override that reads mainnet on a testnet profile is labelled read-only data, never hidden
    expect(venueNetworkEntry("hyperliquid", { CAPSTAN_NETWORK: "testnet", HL_NETWORK: "Mainnet" })).toMatchObject({ network: "mainnet", mainnetReadOnly: true });
    // a venue without a testnet can never be switched to one
    expect(venueNetworkEntry("variational", { CAPSTAN_NETWORK: "testnet" })).toMatchObject({ network: "mainnet", mainnetReadOnly: true });
  });
});
