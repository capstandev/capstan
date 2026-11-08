// @capstan/api: Hono REST app. Routes are drop-in files (src/routes/*.routes.ts, each exporting `routes: RouteSpec[]`),
// found by a sorted glob scan at boot. Every route is wrapped by authGate(spec.auth); a route without a known auth
// value is refused at mount (deny by default), and auth kinds with no verifier registered answer 401.
import { logger, ROUTE_AUTHS, type RouteAuth, type RouteSpec, type RouteWrite } from "@capstan/core";
import { CapstanError, errorBody } from "@capstan/schema";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { join, relative } from "node:path";
import { CREDIT_REFUND } from "./auth/index";
import { corsFor } from "./cors";
import { mountTrpc } from "./trpc";

export const ROUTES_DIR = join(import.meta.dir, "routes");

/** Verifies one auth kind; returns null to allow or a Response to refuse. Todo 29 supplies the real verifiers. */
export type AuthVerifier = (c: Context, spec: RouteSpec) => Promise<Response | null> | Response | null;

export interface CreateAppOptions {
  routesDir?: string;
  verifiers?: Partial<Record<RouteAuth, AuthVerifier>>;
  extraRoutes?: RouteSpec[];
  /** Eligibility edge for write routes (todo 23, `edgeFor` in @capstan/eligibility). Required when any route writes. */
  edge?: (spec: RouteSpec) => MiddlewareHandler;
  /** Cheap IP limiter per route (ratelimit/preAuthLimiter) that runs BEFORE auth, so failed auth is limited too (r1 F1). */
  preAuth?: (spec: RouteSpec) => MiddlewareHandler;
  /** Rate limiter per route (ratelimit/), after auth so it knows the signed wallet or API key. */
  limiter?: (spec: RouteSpec) => MiddlewareHandler;
  /** The x402 payment middleware (todo 33 paymentGate) for priced routes; skipped when credits paid (x402PaidBy). */
  payment?: MiddlewareHandler;
  /** Exact web origins answered with CORS (CAPSTAN_WEB_ORIGINS, parsed by parseWebOrigins). Default none. */
  corsOrigins?: readonly string[];
  /** Request log per route (request-log.ts), outermost so it sees refusals as well as answers. */
  requestLog?: (spec: RouteSpec) => MiddlewareHandler;
}

export interface MountedRoute {
  method: RouteSpec["method"];
  path: string;
  auth: RouteAuth;
  authAlt?: RouteAuth[];
  priced?: string;
  file: string;
  write?: RouteWrite["action"];
}

export class MountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountError";
  }
}

const allowPublic: AuthVerifier = () => null;

export function authGate(auth: RouteAuth | undefined, spec: RouteSpec, verifiers: Partial<Record<RouteAuth, AuthVerifier>>): MiddlewareHandler {
  const kinds = [auth, ...(spec.authAlt ?? [])].filter((k): k is RouteAuth => k !== undefined);
  return async (c, next) => {
    let first: Response | null = null;
    for (const kind of kinds) {
      const verify = kind === "public" ? (verifiers.public ?? allowPublic) : verifiers[kind];
      if (!verify) {
        first ??= c.json(errorBody("UNAUTHORIZED"), 401);
        continue;
      }
      const refusal = await verify(c, spec);
      if (!refusal) {
        // a credit spend is kept only for a 2xx answer (r1:3 F8): the limiter, validation or handler refusing the
        // request (429, 400, 404, 5xx, or a throw) gives it back
        let ok = false;
        try {
          await next();
          ok = c.res.status < 400;
        } finally {
          const refund = (c as unknown as { get(k: string): unknown }).get(CREDIT_REFUND) as (() => Promise<void>) | undefined;
          if (refund && !ok) await refund().catch((e: Error) => logger("api").error("credit refund failed", { error: e.message }));
        }
        return;
      }
      first ??= refusal;
    }
    return first ?? c.json(errorBody("UNAUTHORIZED"), 401);
  };
}

function validateSpec(spec: unknown, file: string): RouteSpec {
  const s = spec as Partial<RouteSpec> | null;
  if (!s || typeof s !== "object") throw new MountError(`${file}: route is not an object`);
  if (!s.auth || !ROUTE_AUTHS.includes(s.auth)) throw new MountError(`${file}: route ${s.method ?? "?"} ${s.path ?? "?"} has no auth (deny by default)`);
  if (s.method !== "GET" && s.method !== "POST" && s.method !== "DELETE") throw new MountError(`${file}: route ${s.path ?? "?"} has a bad method`);
  if (typeof s.path !== "string" || !s.path.startsWith("/")) throw new MountError(`${file}: route path must start with /`);
  if (typeof s.handler !== "function") throw new MountError(`${file}: route ${s.method} ${s.path} has no handler`);
  if (s.authAlt !== undefined && (!Array.isArray(s.authAlt) || s.authAlt.some((a) => !ROUTE_AUTHS.includes(a) || a === "public"))) throw new MountError(`${file}: route ${s.method} ${s.path} has a bad authAlt`);
  if (s.auth === "x402" && !s.priced) throw new MountError(`${file}: x402 route ${s.method} ${s.path} has no price`);
  if (s.write !== undefined && !["onboarding", "order", "spread_leg"].includes((s.write as { action?: string } | null)?.action ?? "")) throw new MountError(`${file}: route ${s.method} ${s.path} has a bad write action`);
  return s as RouteSpec;
}

/** Scan the routes folder (sorted) and return every route with the file it came from. */
export async function discoverRoutes(dir = ROUTES_DIR): Promise<{ spec: RouteSpec; file: string }[]> {
  const files: string[] = [];
  for await (const f of new Bun.Glob("*.routes.ts").scan({ cwd: dir, onlyFiles: true })) files.push(f);
  files.sort();
  const out: { spec: RouteSpec; file: string }[] = [];
  for (const f of files) {
    const abs = join(dir, f);
    const mod = (await import(abs)) as { routes?: unknown };
    if (!Array.isArray(mod.routes)) throw new MountError(`${f}: must export routes: RouteSpec[]`);
    for (const r of mod.routes) out.push({ spec: validateSpec(r, f), file: relative(dir, abs) });
  }
  return out;
}

/**
 * The edge from the environment, built on the first write request: DB-IP country file, the decision tables and
 * refusal receipts through the receipt-sign worker. Without DATABASE_URL and REDIS_URL every write is refused (503).
 */
export function envEdge(env: Record<string, string | undefined> = process.env): (spec: RouteSpec) => MiddlewareHandler {
  let made: Promise<(spec: RouteSpec) => MiddlewareHandler> | null = null;
  const make = async () => {
    if (!env.DATABASE_URL || !env.REDIS_URL) return null;
    const { createDb, createRedis } = await import("@capstan/core");
    const { edgeFor, fileGeo, GEO_FILE } = await import("@capstan/eligibility");
    const { queuedReceipts } = await import("@capstan/relay");
    const db = createDb(env.DATABASE_URL, { max: 4 });
    const receipts = queuedReceipts(createRedis(env.REDIS_URL, { forBullmq: true }), db);
    return edgeFor({ geo: fileGeo(join(env.CAPSTAN_GEO_DIR ?? "var/geo", GEO_FILE)), db, now: () => new Date(), issue: (d) => receipts.issue(d), trustForwardedFor: env.CAPSTAN_TRUST_FORWARDED_FOR === "1" });
  };
  return (spec) => {
    let mw: MiddlewareHandler | null = null;
    return async (c, next) => {
      if (!mw) {
        const f = await (made ??= make().then((x) => x ?? (() => ((cc: Context) => cc.json(errorBody("INTERNAL_ERROR", "Eligibility is not configured on this host."), 503)) as unknown as MiddlewareHandler)));
        mw = f(spec);
      }
      return mw(c, next);
    };
  };
}

/** The route auth table (API-2): every mounted route with its auth kind, price and write flag. */
export function routeTable(routes: MountedRoute[]): { method: string; path: string; auth: RouteAuth; authAlt?: RouteAuth[]; priced?: string; write: boolean; action?: string }[] {
  return routes
    .map((r) => ({ method: r.method, path: `/v1${r.path}`, auth: r.auth, ...(r.authAlt ? { authAlt: r.authAlt } : {}), ...(r.priced ? { priced: r.priced } : {}), write: r.write !== undefined, ...(r.write ? { action: r.write } : {}) }))
    .sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

export async function createApp(opts: CreateAppOptions = {}): Promise<{ app: Hono; routes: MountedRoute[] }> {
  const found = await discoverRoutes(opts.routesDir);
  // the real routes folder always mounts with an edge; a custom folder must pass its own (mount check, todo 23)
  if (!opts.edge && opts.routesDir === undefined) opts = { ...opts, edge: envEdge() };
  for (const r of opts.extraRoutes ?? []) found.push({ spec: validateSpec(r, "extraRoutes"), file: "extraRoutes" });
  const verifiers = opts.verifiers ?? {};
  const v1 = new Hono();
  const seen = new Set<string>();
  const mounted: MountedRoute[] = [];
  for (const { spec, file } of found) {
    const key = `${spec.method} ${spec.path}`;
    if (seen.has(key)) throw new MountError(`${file}: duplicate route ${key}`);
    seen.add(key);
    if (spec.write && !opts.edge) throw new MountError(`${file}: write route ${key} has no eligibility edge`);
    const chain: MiddlewareHandler[] = [];
    if (opts.requestLog) chain.push(opts.requestLog(spec));
    if (opts.preAuth) chain.push(opts.preAuth(spec));
    chain.push(authGate(spec.auth, spec, verifiers));
    if (opts.limiter) chain.push(opts.limiter(spec));
    if (spec.auth === "x402" && opts.payment) {
      const pay = opts.payment;
      chain.push((c, next) => (["credits", "internal"].includes(String((c as unknown as { get(k: string): unknown }).get("x402PaidBy"))) ? next() : pay(c, next)));
    }
    if (spec.write) chain.push(opts.edge!(spec));
    const final: MiddlewareHandler = async (c) => {
      // a write route's handler never runs without a decision id
      if (spec.write && !(c as unknown as { get(k: string): unknown }).get("eligibilityDecisionId")) return c.json(errorBody("INTERNAL_ERROR"), 500);
      return spec.handler(c);
    };
    (v1.on as unknown as (m: string, p: string, ...h: MiddlewareHandler[]) => void)(spec.method, spec.path, ...chain, final);
    mounted.push({ method: spec.method, path: spec.path, auth: spec.auth, ...(spec.authAlt ? { authAlt: spec.authAlt } : {}), ...(spec.priced ? { priced: spec.priced.usd } : {}), file, ...(spec.write ? { write: spec.write.action } : {}) });
  }
  const app = new Hono();
  app.use("*", corsFor(opts.corsOrigins ?? []));
  app.route("/v1", v1);
  mountTrpc(app, mounted);
  app.notFound((c) => c.json(errorBody("NOT_FOUND"), 404));
  app.onError((err, c) => {
    if (err instanceof CapstanError) return c.json(err.toBody(), err.status as 400);
    return c.json(errorBody("INTERNAL_ERROR"), 500);
  });
  return { app, routes: mounted };
}
