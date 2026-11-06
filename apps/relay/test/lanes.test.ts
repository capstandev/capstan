// R6, R7, R17 (todo 30): the free lane takes 2 orders per minute per wallet with a direct-mode hint on the third, pro
// jobs run before queued free jobs, IPv6 clients in one /64 share a bucket, and any wallet above 20 orders per minute
// is pushed to direct mode whatever its lane.
import { afterAll, describe, expect, test } from "bun:test";
import { priorityDispatcher } from "../src/dispatch";
import { ipBucket } from "../src/ip";
import { BOT_CAP_PER_MIN, DIRECT_MODE_HINT, memoryLaneLimiter } from "../src/lanes";
import { handleSubmit } from "../src/pipeline";
import { codeOf, NOW, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("lanes", () => {
  test("free-2-per-min-and-priority", async () => {
    const s = relayStack();
    stacks.push(s);
    s.laneOf.value = async () => ({ lane: "free", perMin: 2 });
    let now = NOW;
    s.deps.now = () => now;
    const submit = async () => {
      const h = await s.hl();
      s.store.builds.get(h.b.buildId)!.expiresAt = now + 30_000;
      return codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.20" }, s.deps));
    };
    expect((await submit()).code).toBeNull();
    expect((await submit()).code).toBeNull();
    const third = await submit();
    expect(third.code).toBe("VENUE_RATE_LIMITED");
    expect(third.message).toBe(DIRECT_MODE_HINT);
    expect(s.venues.hl.length).toBe(2);
    // the refused payload was not consumed: nothing was sent, and the window frees after a minute
    now += 60_001;
    expect((await submit()).code).toBeNull();
    // cancels are safety traffic and never count against the free lane
    const c = await s.hl({}, { kind: "cancel" });
    s.store.builds.get(c.b.buildId)!.expiresAt = now + 30_000;
    expect((await codeOf(handleSubmit({ buildId: c.b.buildId, signedEnvelope: c.env }, { ip: "203.0.113.20" }, s.deps))).code).toBeNull();

    // priority under load: with one worker busy, queued pro jobs all run before queued free jobs
    const d = priorityDispatcher(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ran: string[] = [];
    const blocker = d.run("free", () => gate);
    const jobs = [...Array(5)].flatMap((_, i) => [d.run("free", async () => void ran.push(`free${i}`)), d.run("pro", async () => void ran.push(`pro${i}`))]);
    release();
    await Promise.all([blocker, ...jobs]);
    expect(ran.slice(0, 5).every((x) => x.startsWith("pro"))).toBe(true);
    expect(ran.slice(5).every((x) => x.startsWith("free"))).toBe(true);

    // and through the pipeline: pro submits reach the venue first
    const s2 = relayStack({ concurrency: 1 });
    stacks.push(s2);
    s2.laneOf.value = async (_o, k) => (k === "pro" ? { lane: "pro", perMin: 20 } : { lane: "free", perMin: 20 });
    s2.deps.lanes = { take: async (o) => ({ ok: true, lane: o.lane }) };
    let open!: () => void;
    const hold = s2.deps.dispatch.run("safety", () => new Promise<void>((r) => (open = r)));
    const made = [];
    for (let i = 0; i < 6; i++) made.push({ lane: i % 2 ? "pro" : "free", h: await s2.hl() });
    const subs = made.map((m) => handleSubmit({ buildId: m.h.b.buildId, signedEnvelope: m.h.env }, { ip: "203.0.113.21", apiKey: m.lane }, s2.deps));
    await Bun.sleep(20);
    open();
    await Promise.all([hold, ...subs]);
    const nonceLane = new Map(made.map((m) => [m.h.b.payload.nonce, m.lane]));
    const order = s2.venues.hl.map((r) => nonceLane.get((JSON.parse(r.body) as { nonce: number }).nonce));
    expect(order).toEqual(["pro", "pro", "pro", "free", "free", "free"]);
  });

  test("ipv6-64", async () => {
    expect(ipBucket("2001:db8:1:2::1")).toBe(ipBucket("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(ipBucket("2001:db8:1:2::1")).not.toBe(ipBucket("2001:db8:1:3::1"));
    expect(ipBucket("::ffff:192.0.2.1")).toBe(ipBucket("192.0.2.1"));
    expect(ipBucket("192.0.2.1")).not.toBe(ipBucket("192.0.2.2"));
    const l = memoryLaneLimiter();
    const take = (wallet: string, ip: string) => l.take({ wallet, ipBucket: ipBucket(ip), lane: "free", perMin: 2, kind: "order", nowMs: NOW });
    // three wallets in one /64: the /64 bucket allows two orders in total
    expect((await take("0xaa", "2001:db8:1:2::1")).ok).toBe(true);
    expect((await take("0xbb", "2001:db8:1:2::2")).ok).toBe(true);
    const third = await take("0xcc", "2001:db8:1:2:abcd::9");
    expect(third).toMatchObject({ ok: false, reason: "free_ip" });
    // another /64 has its own bucket
    expect((await take("0xcc", "2001:db8:1:3::1")).ok).toBe(true);
  });

  test("bots-to-direct", async () => {
    const s = relayStack();
    stacks.push(s);
    s.laneOf.value = async () => ({ lane: "pro", perMin: 1000 });
    const results: (string | null)[] = [];
    let last: Awaited<ReturnType<typeof codeOf>> | null = null;
    for (let i = 0; i < BOT_CAP_PER_MIN + 1; i++) {
      const h = await s.hl();
      last = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.30" }, s.deps));
      results.push(last.code);
    }
    expect(results.slice(0, BOT_CAP_PER_MIN).every((c) => c === null)).toBe(true);
    expect(last!.code).toBe("VENUE_RATE_LIMITED");
    expect(last!.message).toBe(DIRECT_MODE_HINT);
    expect(last!.field).toBe("bot_cap");
    expect(s.venues.hl.length).toBe(BOT_CAP_PER_MIN);
    // a cancel from the same wallet still passes (safety traffic)
    const c = await s.hl({}, { kind: "cancel" });
    expect((await codeOf(handleSubmit({ buildId: c.b.buildId, signedEnvelope: c.env }, { ip: "203.0.113.30" }, s.deps))).code).toBeNull();
  });
});
