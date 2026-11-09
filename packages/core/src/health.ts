// Shared /health body for the public services (todo uptime, tracker line 88). The answer is always a quick 200 that
// is never cached: { ok, service, version, degraded, failing }. ok means the process answers; degraded means a
// dependency check failed on the last probe. Dependency checks run at most once per ttlMs and each is capped at
// timeoutMs, so an outside monitor hitting the endpoint every minute never loads the database or waits on it.
import { realpathSync } from "node:fs";
import { basename } from "node:path";

export type HealthCheck = () => Promise<unknown>;

export interface HealthBody {
  ok: true;
  service: string;
  version: string;
  degraded: boolean;
  failing: string[];
}

/** Headers that stop every cache (browser, CDN, proxy) from storing the health answer. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * The running release. CAPSTAN_VERSION wins; else the release directory name when the process runs from
 * /opt/capstan/releases/<sha> (capstan-deploy switches /opt/capstan/current to it); else "dev".
 */
export function releaseVersion(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const set = env.CAPSTAN_VERSION?.trim();
  if (set) return set.slice(0, 64);
  try {
    const dir = basename(realpathSync(cwd));
    if (SHA.test(dir)) return dir.slice(0, 12);
  } catch {
    // cwd gone: fall through
  }
  return "dev";
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

export interface HealthProbeOptions {
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * A cached probe over named dependency checks. failing() returns the names that failed on the last run; it reruns
 * the checks only when the last run is older than ttlMs, and one run is shared by concurrent callers.
 */
export function healthProbe(checks: Record<string, HealthCheck>, o: HealthProbeOptions = {}): { failing(): Promise<string[]> } {
  const ttl = o.ttlMs ?? 5000;
  const timeout = o.timeoutMs ?? 400;
  const now = o.now ?? Date.now;
  let last: { at: number; failing: string[] } | null = null;
  let running: Promise<string[]> | null = null;
  const run = async (): Promise<string[]> => {
    const names = Object.keys(checks);
    const results = await Promise.allSettled(names.map((n) => withTimeout(Promise.resolve().then(checks[n]!), timeout)));
    const failing = names.filter((_, i) => results[i]!.status === "rejected" || (results[i] as PromiseFulfilledResult<unknown>).value === false);
    last = { at: now(), failing };
    return failing;
  };
  return {
    failing() {
      if (last && now() - last.at < ttl) return Promise.resolve(last.failing);
      running ??= run().finally(() => (running = null));
      return running;
    },
  };
}

export async function healthBody(service: string, version: string, probe?: { failing(): Promise<string[]> }): Promise<HealthBody> {
  const failing = probe ? await probe.failing() : [];
  return { ok: true, service, version, degraded: failing.length > 0, failing };
}

/** The health answer as a Response: 200, JSON, never cached. */
export function healthResponse(body: HealthBody): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...NO_STORE_HEADERS } });
}
