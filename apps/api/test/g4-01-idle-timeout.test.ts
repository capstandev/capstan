// G4-01: every Bun.serve sets idleTimeout above the longest wait one request makes. Bun's default closes a socket that
// has sent no byte for 10 s; SERVER_IDLE_TIMEOUT_S keeps a request held 15 s (a venue fetch plus a relay answer)
// open, and every server entry point uses it.
import { afterAll, expect, test } from "bun:test";
import { SERVER_IDLE_TIMEOUT_S } from "@capstan/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
// Bun checks idle sockets on a coarse timer: a socket idle 10 s is closed somewhere between 10 and 14 s
const HOLD_MS = 15_000;
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

async function held(opts: { idleTimeout?: number }): Promise<string> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", ...opts, fetch: async () => (await Bun.sleep(HOLD_MS), new Response("ok")) });
  servers.push(server);
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}/`, { signal: AbortSignal.timeout(HOLD_MS + 5_000) });
    return `${r.status} ${await r.text()}`;
  } catch (e) {
    return `closed ${(e as { code?: string }).code ?? String(e)}`;
  }
}

test("a request held 15 s: Bun's default closes it, SERVER_IDLE_TIMEOUT_S answers it", async () => {
  expect(SERVER_IDLE_TIMEOUT_S).toBeGreaterThanOrEqual(40); // above the relay's 30 s safety lane plus a venue fetch
  expect(SERVER_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255); // Bun's maximum
  const [dflt, ours] = await Promise.all([held({}), held({ idleTimeout: SERVER_IDLE_TIMEOUT_S })]);
  expect(dflt).toStartWith("closed"); // the fork run's ECONNRESET
  expect(ours).toBe("200 ok");
}, 30_000);

test("every server entry point sets idleTimeout: SERVER_IDLE_TIMEOUT_S", () => {
  for (const f of ["apps/api/src/index.ts", "apps/mcp/src/index.ts", "apps/facilitator/src/index.ts", "apps/relay/src/index.ts"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const serves = src.match(/Bun\.serve\(/g)?.length ?? 0;
    expect(serves, f).toBeGreaterThan(0);
    expect(src.match(/idleTimeout: SERVER_IDLE_TIMEOUT_S/g)?.length ?? 0, f).toBe(serves);
  }
});
