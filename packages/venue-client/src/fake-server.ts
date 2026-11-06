// A fake venue for tests: Bun.serve on port 0. Routes are "METHOD /path" or "/path" (any method). An unknown route
// answers 404 (never 200), so a test cannot pass by accident against a URL the venue does not have; venue-specific
// "unknown item" answers come from the recorded error fixtures (errorResponse).
import { loadFixtureRecord } from "./fixtures";

export type FakeHandler = (req: Request) => Response | Promise<Response>;

export function fakeVenueServer(routes: Record<string, FakeHandler>): { url: string; stop(): void; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const key = `${req.method} ${u.pathname}`;
      hits.push(key);
      const h = routes[key] ?? routes[u.pathname];
      if (!h) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
      return h(req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), hits };
}

/** The venue's real answer for an unknown item, from an error fixture (status and body as recorded). */
export function errorResponse(venue: string, name: string): Response {
  const r = loadFixtureRecord<unknown>(venue, name);
  const body = typeof r.response === "string" ? r.response : JSON.stringify(r.response);
  return new Response(body, { status: r.status, headers: { "content-type": typeof r.response === "string" ? "text/plain" : "application/json" } });
}

/** A route that serves a recorded fixture with its recorded status. */
export function fixtureResponse(venue: string, name: string): Response {
  return errorResponse(venue, name);
}
