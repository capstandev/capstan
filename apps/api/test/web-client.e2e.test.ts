// Todo 39 follow-up, end to end: the web dashboard's own API client (web/src/app/api.ts createDashApi) calls a
// BOOTED API process (bun apps/api/src/index.ts on Postgres and Redis, the real gateway, verifiers and CORS) from the
// dashboard's origin and gets 200 on an owner-signed read (the Receipts screen's listing), readable by that origin.
// Needs DATABASE_URL and REDIS_URL (migrated database), like the other integration tests; skips without them.
import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hashMessage } from "viem";
import { signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import type { WalletSigner } from "../../../packages/sdk/src/wallet";
import { ApiError, createDashApi } from "../../../web/src/app/api";
import { addr, gwKey } from "./gw-helpers";

const DB = process.env.DATABASE_URL;
const REDIS = process.env.REDIS_URL;
const live = Boolean(DB && REDIS);
const WEB = "http://127.0.0.1:23373"; // the dashboard's origin in this test (nothing is served there)
const ROOT = join(import.meta.dir, "../../..");

let proc: Subprocess | null = null;
let port = 0;
const log: string[] = [];

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

beforeAll(async () => {
  if (!live) return;
  port = Number(process.env.CAPSTAN_E2E_API_PORT ?? (await freePort()));
  proc = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CAPSTAN_NETWORK: "local", LOG_LEVEL: "info", API_PORT: String(port), PUBLIC_API_HOST: `127.0.0.1:${port}`, DATABASE_URL: DB!, REDIS_URL: REDIS!, X402_ENABLED: "0", CAPSTAN_WEB_ORIGINS: WEB },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) void new Response(stream).text().then((t) => log.push(t));
  const until = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until || proc.exitCode !== null) throw new Error(`the API did not boot: ${log.join("")}`);
    await Bun.sleep(150);
  }
}, 30_000);

afterAll(async () => {
  if (!proc) return;
  proc.kill("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(5_000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
});

/** fetch as the browser sends it from the dashboard: with the page's Origin, and the answer kept for its headers. */
function browserFetch(origin: string, seen: Response[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    h.set("origin", origin);
    const r = await fetch(input, { ...init, headers: h });
    seen.push(r.clone());
    return r;
  }) as typeof fetch;
}

describe.skipIf(!live)("web dashboard client on a booted API", () => {
  test("owner-signed-read-200", async () => {
    const apiBase = `http://127.0.0.1:${port}/v1`;
    // the owner's wallet: an EIP-191 signer over a label-derived test key, reached only as a WalletSigner
    const sk = gwKey("web-e2e-owner"); // test-key (label-derived)
    const owner = addr(sk);
    const wallet: WalletSigner = {
      address: async () => owner,
      signMessage: async (text) => signDigestRsv(hashMessage(text), sk),
      signTypedData: async () => {
        throw new Error("not used here");
      },
    };

    // the browser's preflight for the signed GET: allowed for the dashboard's origin, with the owner_sig headers
    const pre = await fetch(`${apiBase}/receipts?owner=${owner}`, { method: "OPTIONS", headers: { origin: WEB, "access-control-request-method": "GET", "access-control-request-headers": "accept, x-capstan-message, x-capstan-signature" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(WEB);
    expect((pre.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("x-capstan-signature");

    // the dashboard client signs the listing with the owner's wallet (purpose api_request) and gets 200
    const seen: Response[] = [];
    const api = createDashApi({ apiBase, fetch: browserFetch(WEB, seen), wallet, owner, chainId: 4663, now: Date.now });
    const r = await api.signed<{ receipts: unknown[]; next: string | null }>("GET", `/receipts?owner=${owner}`);
    expect(seen.at(-1)!.status).toBe(200);
    expect(seen.at(-1)!.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(Array.isArray(r.receipts)).toBe(true);
    expect(r.next).toBeNull();

    // the same read unsigned is refused, and the refusal is readable by the dashboard (it shows the message)
    const unsigned = await api.get(`/receipts?owner=${owner}`).catch((e) => e);
    expect(unsigned).toBeInstanceOf(ApiError);
    expect((unsigned as ApiError).status).toBe(401);
    expect(seen.at(-1)!.headers.get("access-control-allow-origin")).toBe(WEB);

    // another origin gets the answer without any CORS header, so a page there cannot read it
    const other: Response[] = [];
    const otherApi = createDashApi({ apiBase, fetch: browserFetch("https://evil.example", other), wallet, owner, chainId: 4663, now: Date.now });
    await otherApi.signed("GET", `/receipts?owner=${owner}`);
    expect(other.at(-1)!.headers.get("access-control-allow-origin")).toBeNull();
  });
});
