// R15: random interleavings of acquire, observe(429/418) and time jumps never produce a negative count, never grant
// more than the lane allows inside any window, and never grant a lease while a ban is in force.
import { afterAll, describe, expect, test } from "bun:test";
import { budgetFor, laneCap, type BucketKey, type Priority } from "../src/budgets";
import type { Lease } from "../src/governor";
import { closeClients, fakeClock, makeGov, STORE_KINDS } from "./helpers";

afterAll(closeClients);

const VENUES: BucketKey[] = ["aster", "variational", "lighter-304", "hyperliquid"];
const PRI: Priority[] = ["safety", "pro", "free"];

for (const kind of STORE_KINDS) {
  describe(`governor fuzz (${kind})`, () => {
    test("token-bucket-fuzz", async () => {
      let s = 0xca95 >>> 0;
      const rnd = (n: number) => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s % n;
      };
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      const leases = new Map<BucketKey, Lease[]>(VENUES.map((v) => [v, []]));
      const banned = new Map<BucketKey, number>();
      let granted = 0;
      for (let i = 0; i < 5000; i++) {
        const v = VENUES[rnd(VENUES.length)]!;
        const op = rnd(10);
        if (op < 7) {
          const pri = PRI[rnd(3)]!;
          const b = budgetFor(v);
          const cost = 1 + rnd(Math.max(1, Math.min(30, laneCap(b.perWindow, "free"))));
          const before = clock.t;
          try {
            const l = await gov.acquire(v, cost, { priority: pri, deadlineMs: rnd(4) * 5000 });
            granted++;
            // never during a ban
            expect(l.at >= (banned.get(v) ?? 0)).toBe(true);
            expect(l.at >= before).toBe(true);
            // inside the window ending at this lease, the total is within the lane cap
            const list = leases.get(v)!;
            list.push(l);
            const inWindow = list.filter((x) => x.at > l.at - b.windowMs).reduce((n, x) => n + x.cost, 0);
            expect(inWindow).toBeLessThanOrEqual(laneCap(b.perWindow, pri));
            // the count never goes negative or above the limit
            const u = gov.usage(v);
            expect(u.used >= 0 && u.used <= b.perWindow).toBe(true);
          } catch (e) {
            expect((e as Error).name).toBe("CapstanError");
          }
        } else if (op === 7) {
          gov.observe(v, { status: 429, headers: new Headers(rnd(2) ? { "retry-after": String(1 + rnd(3)) } : {}) });
        } else if (op === 8 && rnd(8) === 0) {
          const until = clock.t + 1000 * (1 + rnd(90));
          banned.set(v, Math.max(banned.get(v) ?? 0, until));
          gov.observe(v, { status: 418, headers: new Headers({ "retry-after": String((until - clock.t) / 1000) }) });
          await gov.flush();
        } else {
          clock.t += rnd(120_000);
        }
      }
      expect(granted).toBeGreaterThan(1000);
    }, 120_000);
  });
}
