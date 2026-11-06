// @capstan/api: Hono REST app. Routes are drop-in files (src/routes/*.routes.ts, each exporting `routes: RouteSpec[]`),
// found by a sorted glob scan at boot. Every route is wrapped by authGate(spec.auth); a route without a known auth
// value is refused at mount (deny by default), and auth kinds with no verifier registered answer 401.
import { ROUTE_AUTHS, type RouteAuth, type RouteSpec, type RouteWrite } from "@capstan/core";
import { CapstanError, errorBody } from "@capstan/schema";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { join, relative } from "node:path";
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
}

export interface MountedRoute {
  method: RouteSpec["method"];
  path: string;
  auth: RouteAuth;
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
  return async (c, next) => {
    const verify = auth === "public" ? (verifiers.public ?? allowPublic) : auth ? verifiers[auth] : undefined;
    if (!verify) return c.json(errorBody("UNAUTHORIZED"), 401);
    const refusal = await verify(c, spec);
    if (refusal) return refusal;
    await next();
  };
}

function validateSpec(spec: unknown, file: string): RouteSpec {
  const s = spec as Partial<RouteSpec> | null;
  if (!s || typeof s !== "object") throw new MountError(`${file}: route is not an object`);
  if (!s.auth || !ROUTE_AUTHS.includes(s.auth)) throw new MountError(`${file}: route ${s.method ?? "?"} ${s.path ?? "?"} has no auth (deny by default)`);
  if (s.method !== "GET" && s.method !== "POST" && s.method !== "DELETE") throw new MountError(`${file}: route ${s.path ?? "?"} has a bad method`);
  if (typeof s.path !== "string" || !s.path.startsWith("/")) throw new MountError(`${file}: route path must start with /`);
  if (typeof s.handler !== "function") throw new MountError(`${file}: route ${s.method} ${s.path} has no handler`);
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

export async function createApp(opts: CreateAppOptions = {}): Promise<{ app: Hono; routes: MountedRoute[] }> {
  const found = await discoverRoutes(opts.routesDir);
  for (const r of opts.extraRoutes ?? []) found.push({ spec: validateSpec(r, "extraRoutes"), file: "extraRoutes" });
  const verifiers = opts.verifiers ?? {};
  const v1 = new Hono();
  const seen = new Set<string>();
  const mounted: MountedRoute[] = [];
  for (const { spec, file } of found) {
    const key = `${spec.method} ${spec.path}`;
    if (seen.has(key)) throw new MountError(`${file}: duplicate route ${key}`);
    seen.add(key);
    if (spec.write) {
      // a write route never mounts without the eligibility edge, and its handler never runs without a decision id
      if (!opts.edge) throw new MountError(`${file}: write route ${key} has no eligibility edge`);
      v1.on(spec.method, spec.path, authGate(spec.auth, spec, verifiers), opts.edge(spec), (c) => {
        if (!(c as unknown as { get(k: string): unknown }).get("eligibilityDecisionId")) return c.json(errorBody("INTERNAL_ERROR"), 500);
        return spec.handler(c);
      });
    } else {
      v1.on(spec.method, spec.path, authGate(spec.auth, spec, verifiers), (c) => spec.handler(c));
    }
    mounted.push({ method: spec.method, path: spec.path, auth: spec.auth, file, ...(spec.write ? { write: spec.write.action } : {}) });
  }
  const app = new Hono();
  app.route("/v1", v1);
  mountTrpc(app);
  app.notFound((c) => c.json(errorBody("NOT_FOUND"), 404));
  app.onError((err, c) => {
    if (err instanceof CapstanError) return c.json(err.toBody(), err.status as 400);
    return c.json(errorBody("INTERNAL_ERROR"), 500);
  });
  return { app, routes: mounted };
}
