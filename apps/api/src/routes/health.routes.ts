// GET /v1/health: a quick, never-cached 200 for the deploy probe and the outside uptime monitor (ops/uptime).
// Body: { ok, service, version, degraded, failing }. degraded is true when Postgres or Redis did not answer on the
// last probe (one probe per 5 s at most, each check capped at 400 ms), so the endpoint never waits long or loads
// the database. No data, no auth.
import { createDb, createRedis, healthBody, healthProbe, healthResponse, releaseVersion, type HealthCheck, type RouteSpec } from "@capstan/core";

export interface HealthRouteDeps {
  version: string;
  probe: { failing(): Promise<string[]> };
}

/** Checks from the environment: Postgres `select 1` and Redis PING, each only when its URL is set. */
export function envHealthChecks(env: Record<string, string | undefined> = process.env): Record<string, HealthCheck> {
  const checks: Record<string, HealthCheck> = {};
  if (env.DATABASE_URL) {
    let db: ReturnType<typeof createDb> | null = null;
    checks.postgres = async () => {
      db ??= createDb(env.DATABASE_URL!, { max: 1 });
      await db.$client`select 1`;
    };
  }
  if (env.REDIS_URL) {
    let redis: ReturnType<typeof createRedis> | null = null;
    checks.redis = async () => {
      redis ??= createRedis(env.REDIS_URL!, { lazyConnect: true });
      if ((await redis.ping()) !== "PONG") throw new Error("no PONG");
    };
  }
  return checks;
}

export function createHealthRoutes(deps: () => HealthRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/health",
      auth: "public",
      description: "Liveness check",
      handler: async () => {
        const d = deps();
        return healthResponse(await healthBody("api", d.version, d.probe));
      },
    },
  ];
}

let resolved: HealthRouteDeps | undefined;
export const routes: RouteSpec[] = createHealthRoutes(() => (resolved ??= { version: releaseVersion(), probe: healthProbe(envHealthChecks()) }));
