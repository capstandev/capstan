// Go-live kits (tracker line 83). Every dry run here reads the fork stand-in venues (ops/fork/fake-venues.ts) on
// loopback ports 24780 to 24783 and must leave them with zero order posts. Sends use a stand-in SDK client only;
// nothing in this file can reach a real venue (every HTTP call is asserted to be loopback).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeVenues } from "../../fork/fake-venues";
import { KITS, readOnlyFetch, runKit, smallestSize, switchesFor, type Kit, type KitClient, type Net } from "../kit";

const GOLIVE = join(import.meta.dir, "..");
const ROOT = join(GOLIVE, "../..");
const PORTS = { hl: 24780, lighterRh: 24781, lighter: 24782, aster: 24783 };
const URL_OF: Record<Kit, string> = { "hl-core": `http://127.0.0.1:${PORTS.hl}`, hip3: `http://127.0.0.1:${PORTS.hl}`, lighter: `http://127.0.0.1:${PORTS.lighter}`, "lighter-rh": `http://127.0.0.1:${PORTS.lighterRh}`, aster: `http://127.0.0.1:${PORTS.aster}` };

let v: ReturnType<typeof startFakeVenues>;
const seen: string[] = [];
const loopFetch = (async (u: string | URL | Request, init?: RequestInit) => {
  const url = u instanceof Request ? u.url : String(u);
  seen.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
  if (!url.startsWith("http://127.0.0.1:")) throw new Error(`test refused a non-loopback request: ${url}`);
  return fetch(u, init);
}) as typeof fetch;

const venuePosts = () => v.hl.exchangePosts.length + v.rh.sent.length + v.lm.sent.length + v.as.sent.length;

beforeAll(() => {
  v = startFakeVenues(PORTS);
});
afterAll(() => v.stop());

async function run(kit: Kit, net: Net, extra: { send?: boolean; env?: Record<string, string>; market?: string; client?: KitClient; mode?: "relay" | "direct" } = {}) {
  const lines: string[] = [];
  let made = 0;
  const code = await runKit({
    kit,
    net,
    send: extra.send ?? false,
    ...(extra.mode ? { mode: extra.mode } : {}),
    ...(extra.market ? { market: extra.market } : {}),
    env: { GOLIVE_VENUE_URL: URL_OF[kit], ...extra.env },
    fetch: loopFetch,
    client: async () => {
      made++;
      if (!extra.client) throw new Error("no client in this test");
      return extra.client;
    },
    log: (l) => lines.push(l),
  });
  return { code, out: lines.join("\n"), made };
}

// testnet HIP-3 defaults to test:ABC, which the stand-in has no recording of; the dry run reads a recorded dex
const marketFor = (kit: Kit, net: Net) => (kit === "hip3" && net === "testnet" ? "hyperliquid:xyz:XYZ100" : undefined);

describe("dry run against the fork stand-in venues", () => {
  const SIZES: Record<Kit, string> = { "hl-core": "0.00014", hip3: "0.0004", lighter: "0.0045", "lighter-rh": "0.0050", aster: "0.003" };
  for (const kit of KITS)
    for (const net of ["testnet", "mainnet"] as const)
      test(`${kit} ${net}: prints every request, sends none, smallest size ${SIZES[kit]}`, async () => {
        const before = venuePosts();
        const m = marketFor(kit, net);
        const r = await run(kit, net, m ? { market: m } : {});
        expect(r.code).toBe(0);
        expect(r.made).toBe(0);
        expect(venuePosts()).toBe(before);
        expect(r.out).toContain("dry run (nothing is sent)");
        expect(r.out).toContain(`size: ${SIZES[kit]} `);
        expect(r.out).toContain("/v1/orders/build");
        expect(r.out).toContain("/v1/orders/submit");
        expect(r.out).toMatch(/"reduceOnly":false/);
        expect(r.out).toMatch(/"side":"sell".*"reduceOnly":true/);
        expect(r.out).toContain("/proof");
        expect(r.out).toContain("dry run done: nothing was sent");
        for (const s of switchesFor(kit, net, "relay")) expect(r.out).toContain(`${s.name}=${s.want}`);
      });

  test("direct mode prints the venue post and the receipt claim, still sends nothing", async () => {
    const before = venuePosts();
    const r = await run("lighter", "mainnet", { mode: "direct" });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`would send 2: POST ${URL_OF.lighter}/api/v1/sendTx`);
    expect(r.out).toContain("/v1/receipts/claim");
    expect(venuePosts()).toBe(before);
  });

  test("every HTTP call of the dry runs was a read on loopback", () => {
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toMatch(/^(GET http:\/\/127\.0\.0\.1:|POST http:\/\/127\.0\.0\.1:2478\d\/info$)/);
  });

  test("the dry-run HTTP refuses every write path", async () => {
    const f = readOnlyFetch((async () => new Response("{}")) as unknown as typeof fetch);
    for (const p of ["/exchange", "/api/v1/sendTx", "/api/v1/sendTxBatch", "/fapi/v3/order", "/v1/orders/submit"]) await expect(f(`http://127.0.0.1:1${p}`, { method: "POST" })).rejects.toThrow("dry run: refused");
    await expect(f("http://127.0.0.1:1/fapi/v3/order", { method: "DELETE" })).rejects.toThrow("dry run: refused");
    expect((await f("http://127.0.0.1:1/info", { method: "POST" })).status).toBe(200);
  });

  test("a market of the wrong kind is refused", async () => {
    expect((await run("hl-core", "mainnet", { market: "hyperliquid:xyz:XYZ100" })).code).toBe(2);
    expect((await run("hip3", "mainnet", { market: "hyperliquid:-:BTC" })).code).toBe(2);
    expect((await run("aster", "mainnet", { market: "lighter-rh:-:ETH" })).code).toBe(2);
  });
});

describe("smallest size", () => {
  test("rounds up to the step and clears min size and min notional at the worst IOC price", () => {
    expect(smallestSize({ marketId: "x", symbol: "x", mid: 100, decimals: 2, stepUnits: 1, minSize: 0.01, minNotional: 10 })).toBe("0.11");
    expect(smallestSize({ marketId: "x", symbol: "x", mid: 1, decimals: 3, stepUnits: 5, minSize: 0.5, minNotional: 0 })).toBe("0.500");
    expect(smallestSize({ marketId: "x", symbol: "x", mid: 1000, decimals: 3, stepUnits: 5, minSize: 0.001, minNotional: 5 })).toBe("0.010");
  });
});

const ARMED = (kit: Kit, net: Net): Record<string, string> => ({
  ...Object.fromEntries(switchesFor(kit, net, "relay").map((s) => [s.name, s.want])),
  GOLIVE_API: "http://127.0.0.1:24784",
  GOLIVE_KEYFILE: "/nonexistent/keys.json",
  GOLIVE_PASSPHRASE_FILE: "/nonexistent/pass",
  GOLIVE_OWNER: "0x0000000000000000000000000000000000000001",
});

function fakeClient(o: { fill?: string; closeFill?: string; status?: string; closeThrows?: boolean; openSubmitThrows?: boolean } = {}) {
  const calls: { intent: Record<string, unknown>; venue: string; mode: string }[] = [];
  const verified: string[] = [];
  const c: KitClient = {
    buildOrder: async (intent, venue, mode) => {
      calls.push({ intent: intent as never, venue, mode });
      if (intent.reduceOnly && o.closeThrows) throw new Error("venue rejected the close");
      return { intent } as never;
    },
    signAndSubmit: async (b) => {
      const i = (b as unknown as { intent: { size: string; reduceOnly: boolean; marketId: string } }).intent;
      if (!i.reduceOnly && o.openSubmitThrows) throw new Error("socket closed after the post");
      const filled = i.reduceOnly ? (o.closeFill ?? i.size) : (o.fill ?? i.size);
      return { order: { venue: "hyperliquid", marketId: i.marketId, venueOrderId: "1", side: "buy", size: i.size, filled, px: "1", status: "filled" }, receiptId: i.reduceOnly ? "rc_close" : "rc_open" } as never;
    },
    verifyReceipt: async (id) => {
      verified.push(id);
      return { valid: (o.status ?? "valid") === "valid", status: o.status ?? "valid" };
    },
  };
  return { c, calls, verified };
}

describe("arming", () => {
  for (const kit of KITS)
    for (const net of ["testnet", "mainnet"] as const)
      test(`${kit} ${net}: --send refuses unless every switch is set, before any read or client`, async () => {
        const before = venuePosts();
        const n = seen.length;
        const r = await run(kit, net, { send: true, env: { GOLIVE_SEND: "1" } });
        expect(r.code).toBe(2);
        expect(r.made).toBe(0);
        expect(seen.length).toBe(n);
        expect(venuePosts()).toBe(before);
        for (const s of switchesFor(kit, net, "relay").filter((x) => x.name !== "GOLIVE_SEND")) expect(r.out).toContain(`${s.name}=${s.want} is not set`);
        // one switch short of the full set is still a refusal
        for (const s of switchesFor(kit, net, "relay")) {
          const env = ARMED(kit, net);
          delete env[s.name];
          expect((await run(kit, net, { send: true, env })).code).toBe(2);
        }
      });

  test("the switch sets per venue", () => {
    const names = (k: Kit, n: Net) => switchesFor(k, n, "relay").map((s) => s.name);
    expect(names("hl-core", "testnet")).toEqual(["GOLIVE_SEND", "RELAY_SUBMIT_ARMED"]);
    expect(names("hip3", "mainnet")).toEqual(["GOLIVE_SEND", "GOLIVE_CONFIRM", "RELAY_SUBMIT_ARMED", "EQ_EXECUTION_ALLOWED"]);
    expect(names("lighter", "mainnet")).toContain("LIGHTER_EXECUTION");
    expect(names("lighter-rh", "testnet")).toContain("LIGHTER_EXECUTION");
    expect(names("aster", "mainnet")).toContain("ASTER_EXECUTION");
    expect(switchesFor("aster", "mainnet", "relay").find((s) => s.name === "GOLIVE_CONFIRM")!.want).toBe("aster-mainnet");
    expect(switchesFor("hl-core", "mainnet", "direct").map((s) => s.name)).not.toContain("RELAY_SUBMIT_ARMED");
  });

  test("a wrong mainnet confirm word is refused", async () => {
    const env = { ...ARMED("hl-core", "mainnet"), GOLIVE_CONFIRM: "hip3-mainnet" };
    expect((await run("hl-core", "mainnet", { send: true, env })).code).toBe(2);
  });
});

describe("armed send (stand-in SDK client)", () => {
  test("opens the smallest size, closes reduce-only at the filled size, checks both receipts", async () => {
    const f = fakeClient({ fill: "0.0030" });
    const r = await run("lighter-rh", "mainnet", { send: true, env: ARMED("lighter-rh", "mainnet"), client: f.c });
    expect(r.code).toBe(0);
    expect(f.calls.map((c) => [c.intent.side, c.intent.size, c.intent.reduceOnly, c.intent.tif, c.venue, c.mode])).toEqual([
      ["buy", "0.0050", false, "ioc", "lighter-rh", "relay"],
      ["sell", "0.0030", true, "ioc", "lighter-rh", "relay"],
    ]);
    expect(f.verified).toEqual(["rc_open", "rc_close"]);
    expect(r.out).toContain("receipt rc_close: valid");
  });

  test("an anchor still pending exits 3 and names the verify rerun", async () => {
    const f = fakeClient({ status: "pending" });
    const r = await run("hl-core", "testnet", { send: true, env: ARMED("hl-core", "testnet"), client: f.c });
    expect(r.code).toBe(3);
    expect(r.out).toContain("--verify rc_open,rc_close");
  });

  test("an invalid receipt fails the run", async () => {
    expect((await run("aster", "testnet", { send: true, env: ARMED("aster", "testnet"), client: fakeClient({ status: "invalid" }).c })).code).toBe(1);
  });

  test("a failed or partial close fails loudly and says a position is open", async () => {
    const a = await run("hip3", "mainnet", { send: true, env: ARMED("hip3", "mainnet"), client: fakeClient({ closeThrows: true }).c });
    expect(a.code).toBe(1);
    expect(a.out).toContain("FAILED TO CLOSE");
    const b = await run("lighter", "mainnet", { send: true, env: ARMED("lighter", "mainnet"), client: fakeClient({ closeFill: "0.0001" }).c });
    expect(b.code).toBe(1);
    expect(b.out).toContain("FAILED TO CLOSE FULLY");
  });

  test("d1-golive-01: an open whose submit throws warns OPEN OUTCOME UNKNOWN and exits 1", async () => {
    const f = fakeClient({ openSubmitThrows: true });
    const r = await run("hl-core", "mainnet", { send: true, env: ARMED("hl-core", "mainnet"), client: f.c });
    expect(r.code).toBe(1);
    expect(r.out).toContain("OPEN OUTCOME UNKNOWN");
    expect(r.out).toContain("close it on the venue now");
    expect(f.calls.length).toBe(1); // no close is guessed at an unknown size
  });

  test("an unfilled open sends no close", async () => {
    const f = fakeClient({ fill: "0" });
    expect((await run("hl-core", "mainnet", { send: true, env: ARMED("hl-core", "mainnet"), client: f.c })).code).toBe(1);
    expect(f.calls.length).toBe(1);
  });
});

describe("owner commands (macOS bash 3.2)", () => {
  const sh = (k: Kit, net: Net) => join(GOLIVE, k, net === "testnet" ? "testnet-proof.sh" : "mainnet-first-trade.sh");
  test("every command parses under /bin/bash and names its kit and network", () => {
    for (const k of KITS)
      for (const n of ["testnet", "mainnet"] as const) {
        const p = Bun.spawnSync(["/bin/bash", "-n", sh(k, n)]);
        expect(p.exitCode).toBe(0);
        expect(readFileSync(sh(k, n), "utf8")).toContain(`--kit ${k} --network ${n}`);
      }
    expect(Bun.spawnSync(["/bin/bash", "-n", join(GOLIVE, "kit.sh")]).exitCode).toBe(0);
    expect(readFileSync(join(GOLIVE, "kit.sh"), "utf8")).toContain("$HOME/.foundry/bin");
  });

  // async spawn: the stand-ins run in this process, so a blocking spawn would starve them
  const spawn = async (args: string[], env: Record<string, string>) => {
    const p = Bun.spawn(["/bin/bash", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: `${o}${e}` };
  };

  test("the testnet proof dry-runs against the stand-in and the mainnet trade refuses --send unarmed", async () => {
    const before = venuePosts();
    const a = await spawn([sh("hl-core", "testnet")], { GOLIVE_VENUE_URL: URL_OF["hl-core"] });
    expect(a.out).toContain("dry run done: nothing was sent");
    expect(a.code).toBe(0);
    const b = await spawn([sh("aster", "mainnet"), "--send"], { GOLIVE_VENUE_URL: URL_OF.aster, GOLIVE_SEND: "1" });
    expect(b.code).toBe(2);
    expect(b.out).toContain("ASTER_EXECUTION=1 is not set");
    expect(b.out).toContain("GOLIVE_CONFIRM=aster-mainnet is not set");
    const c = await spawn([sh("lighter", "mainnet")], { GOLIVE_VENUE_URL: URL_OF.lighter, GOLIVE_OWNER: "not-an-address" });
    expect(c.code).toBe(2);
    expect(venuePosts()).toBe(before);
  });
});

describe("READMEs", () => {
  for (const kit of KITS)
    test(`${kit}: README covers what it does, switches, size, reduce-only close, receipt check, funding`, () => {
      const f = join(GOLIVE, kit, "README.md");
      expect(existsSync(f)).toBe(true);
      const t = readFileSync(f, "utf8");
      for (const s of new Set([...switchesFor(kit, "mainnet", "relay"), ...switchesFor(kit, "testnet", "relay")])) expect(t).toContain(s.name);
      for (const w of ["testnet-proof.sh", "mainnet-first-trade.sh", "refuses", "reduce-only", "Receipt check", "Fund first", "Size", "Dry run"]) expect(t).toContain(w);
      expect(t).not.toContain("—");
    });
});
