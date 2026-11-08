// Security review r2, R2-RELAY-02: exit traffic from one actor must not refuse every other user's cancels and closes
// on a venue key. The dispatcher is the relay's (8 running, 8 more for safety, 16 waiting); each job waits for a
// shared venue token at a fixed rate like Lighter's 1 per second governor (scaled down here). Attacker wallets flood
// reduce-only exits far faster than the venue serves them; another owner's cancel must still start within its deadline.
import { describe, expect, test } from "bun:test";
import { RELAY_MAX_OPEN_JOBS, priorityDispatcher } from "../src/dispatch";
import { EXIT_CAPS, memoryLaneLimiter } from "../src/lanes";

const TOKEN_MS = 20; // one venue token per 20 ms (Lighter: one per second)
const DEADLINE_MS = 30 * TOKEN_MS * 1.5; // the relay's 30 s safety deadline, scaled to the token rate

function venueTokens() {
  let next = Date.now();
  return async () => {
    const t = Math.max(Date.now(), next);
    next = t + TOKEN_MS;
    await Bun.sleep(Math.max(0, t - Date.now()));
  };
}

const dispatcher = () => priorityDispatcher(8, { maxQueuedPerKey: 16, safetyReserve: 8, maxOpenJobs: RELAY_MAX_OPEN_JOBS });

async function flood(attackers: string[], perAttacker: number) {
  const d = dispatcher();
  const token = venueTokens();
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < perAttacker; i++) for (const a of attackers) jobs.push(d.run("safety", token, "lighter-304", a).catch(() => null));
  // the honest owner's cancel arrives in the middle of the flood
  const t0 = Date.now();
  let startedAt = 0;
  const honest = d.run("safety", async () => ((startedAt = Date.now()), token()), "lighter-304", "0x000000000000000000000000000000000000b0b0").then(
    () => null,
    (e: Error) => e.message,
  );
  for (let i = 0; i < perAttacker; i++) for (const a of attackers) jobs.push(d.run("safety", token, "lighter-304", a).catch(() => null));
  const refused = await honest;
  await Promise.all(jobs);
  return { refused, waitedMs: startedAt ? startedAt - t0 : null };
}

describe("security r2 R2-RELAY-02", () => {
  test("two-flooding-wallets-cannot-refuse-another-owners-cancel", async () => {
    const r = await flood(["0x00000000000000000000000000000000000a77a1", "0x00000000000000000000000000000000000a77a2"], 30);
    expect(r.refused).toBeNull();
    expect(r.waitedMs).not.toBeNull();
    expect(r.waitedMs!).toBeLessThan(DEADLINE_MS);
  });

  test("many-flooding-wallets-are-evicted-for-a-newcomer", async () => {
    const attackers = Array.from({ length: 6 }, (_, i) => `0x00000000000000000000000000000000000a77b${i}`);
    const r = await flood(attackers, 12);
    expect(r.refused).toBeNull();
    expect(r.waitedMs!).toBeLessThan(DEADLINE_MS);
  });

  test("lighter-exit-lane-is-sized-to-its-budget", async () => {
    const lanes = memoryLaneLimiter();
    const cap = EXIT_CAPS["lighter-mainnet"]!;
    expect(cap.ip).toBeLessThanOrEqual(30); // at most half of the 60 a minute shared relay budget
    const take = (wallet: string, venue: "lighter-mainnet" | "hyperliquid") => lanes.take({ wallet, ipBucket: "2001:db8:1::/64", lane: "pro", perMin: 20, kind: "close", nowMs: 1_000, venue });
    let ok = 0;
    for (let i = 0; i < 60; i++) if ((await take("0x00000000000000000000000000000000000a77a1", "lighter-mainnet")).ok) ok++;
    expect(ok).toBe(cap.wallet);
    for (let i = 0; i < 60; i++) if ((await take("0x00000000000000000000000000000000000a77a2", "lighter-mainnet")).ok) ok++;
    expect(ok).toBe(cap.ip);
    // Hyperliquid exits from the same bucket keep the larger weight-based caps
    expect((await take("0x00000000000000000000000000000000000a77a3", "hyperliquid")).ok).toBe(true);
  });
});
