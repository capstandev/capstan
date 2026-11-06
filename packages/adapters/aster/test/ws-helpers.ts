// A fake VenueWs: records subscribe messages and lets a test push venue messages to the subscribers.
import type { VenueWs } from "@capstan/venue-client";

export function fakeWs() {
  const subs = new Map<number, { msg: unknown; on: (m: unknown) => void }>();
  let next = 1;
  let closed = 0;
  const sent: unknown[] = [];
  const ws: VenueWs = {
    subscribe(msg, on) {
      const id = next++;
      subs.set(id, { msg, on });
      sent.push(msg);
      return () => void subs.delete(id);
    },
    close() {
      closed++;
    },
    stats: () => ({ connections: subs.size, opened: subs.size, subscriptions: subs.size, openedAt: [] }),
  };
  return {
    ws,
    sent,
    push(m: unknown) {
      for (const s of subs.values()) s.on(m);
    },
    active: () => [...subs.values()].map((s) => s.msg),
    closed: () => closed,
  };
}
