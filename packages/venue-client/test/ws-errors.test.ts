// Socket errors carry the runtime's text and the refused upgrade's HTTP status (never "[object ErrorEvent]"), and the
// upgrade sends a User-Agent (a venue CDN refuses an upgrade without one with 403).
import { afterAll, describe, expect, test } from "bun:test";
import { venueWs, VenueWsError, wsErrorText } from "../src/ws";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/refuse") return new Response("restricted", { status: 400 });
    if (!req.headers.get("user-agent")) return new Response("forbidden", { status: 403 });
    return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
  },
  websocket: {
    message(ws, m) {
      ws.send(String(m));
    },
  },
});
afterAll(() => server.stop(true));

const opts = { maxConns: 1, maxNewPerMin: 30, maxSubs: 10, pingMs: 0, pingMessage: null, backoffBaseMs: 5_000 };
const waitFor = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(20);
  }
};

describe("ws", () => {
  test("error-text", async () => {
    const errors: unknown[] = [];
    const url = `ws://127.0.0.1:${server.port}/refuse`;
    const pool = venueWs("lighter-304", url, { ...opts, onError: (e) => errors.push(e) });
    pool.subscribe({ type: "subscribe", channel: "x" }, () => undefined);
    await waitFor(() => errors.length > 0);
    pool.close();
    const e = errors[0] as VenueWsError;
    expect(e).toBeInstanceOf(VenueWsError);
    expect(e.message).toContain(url);
    expect(e.message).toContain("400");
    expect(e.httpStatus).toBe(400);
    expect(String(e)).not.toContain("[object");
    // the helper reads every shape a runtime hands over
    expect(wsErrorText({ type: "error", message: "boom" })).toBe("boom");
    expect(wsErrorText({ type: "error", error: new Error("inner") })).toBe("inner");
    expect(wsErrorText({ type: "error" })).toBe("error event with no message");
  });

  test("sends-user-agent", async () => {
    const errors: unknown[] = [];
    const got: unknown[] = [];
    const pool = venueWs("lighter-300", `ws://127.0.0.1:${server.port}/stream`, { ...opts, onError: (e) => errors.push(e) });
    pool.subscribe({ type: "subscribe", channel: "y" }, (m) => got.push(m));
    await waitFor(() => got.length > 0 || errors.length > 0);
    pool.close();
    expect(errors).toEqual([]);
    expect(got[0]).toEqual({ type: "subscribe", channel: "y" });
  });
});
