// Capstan MCP server (spec 13.3, DECISIONS #9): stateless Streamable HTTP on Hono and Bun. Every request gets its own
// McpServer and WebStandardStreamableHTTPServerTransport (no session id), JSON responses, and DNS rebinding protection
// (Host and Origin allow-lists). Tools call the public API through a typed client; the server never receives a key.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { createPaymentWrapper } from "@x402/mcp";
import { getConnInfo } from "hono/bun";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { SERVICE_METRICS, type RequestLogSink } from "@capstan/telemetry";
import { ipBucket } from "@capstan/core";
import { createHash } from "node:crypto";
import type { CapstanApiClient } from "./client";
import { allTools, isPaidCall } from "./tools";
import type { ToolCtx, ToolDef } from "./tools/types";

/** x402 over MCP for paid tools (@x402/mcp createPaymentWrapper): an unpaid call gets PaymentRequired, a paid retry runs. */
export interface McpPayments {
  resourceServer: x402ResourceServer;
  /** The payment options for a paid tool (async on the production host: the rail state is read from chain). */
  accepts(tool: ToolDef): PaymentRequirements[] | Promise<PaymentRequirements[]>;
  /** Token the MCP server sends to the API's priced route once it holds the payment (the API's internal caller). */
  internalToken: string;
}

export interface McpAppDeps {
  api: CapstanApiClient;
  version: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  tools?: ToolDef[];
  /** Wrap a tool handler (tests count server instances with it). */
  wrap?: (tool: ToolDef, handler: (args: unknown, extra: unknown) => Promise<unknown>) => (args: unknown, extra: unknown) => Promise<unknown>;
  payments?: McpPayments;
  /** The caller's address (default: the first X-Forwarded-For entry, else the socket). */
  clientIpOf?: (c: import("hono").Context) => string | null;
  /** request_logs rows (service mcp, route = JSON-RPC method) for the usage report; client ids hashed, never stored raw. */
  requestLog?: { sink: RequestLogSink; hash: (clientId: string) => string };
  /**
   * Per-IP limits (security review r1 review-r1:9 F-1), counted per JSON-RPC message (a batch of 100 is 100):
   * `perMin` messages a minute (MCP_RATE_LIMIT_PER_MIN, default 60) and `paidPerMin` paid tool calls a minute
   * (default 20). Always on: leaving it out uses the defaults.
   */
  rateLimit?: { perMin?: number; paidPerMin?: number; now?: () => number };
}

export const MCP_RATE_LIMIT_PER_MIN = 60;
export const MCP_PAID_PER_MIN = 20;
/** Paid tool calls allowed in one JSON-RPC batch; a batch with more is refused before any payment check. */
export const MCP_MAX_PAID_PER_BATCH = 5;
/** A payment payload the facilitator refused is refused again without another verify for this long. */
export const MCP_NEGATIVE_VERIFY_MS = 60_000;

/** A sliding one-minute window per key (in process: the MCP server is one process behind Caddy). */
function windowLimiter(now: () => number) {
  const hits = new Map<string, number[]>();
  return (key: string, n: number, limit: number): number | null => {
    const t = now();
    const live = (hits.get(key) ?? []).filter((x) => x > t - 60_000);
    if (live.length + n > limit) return Math.max(1, Math.ceil(((live[0] ?? t) + 60_000 - t) / 1000));
    for (let i = 0; i < n; i++) live.push(t);
    hits.set(key, live);
    if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some((x) => x > t - 60_000)) hits.delete(k);
    return null;
  };
}

/**
 * The resource server with a guarded verify (r1 F-1): concurrent verifies of one payload share one facilitator call,
 * and a payload the facilitator refused is refused again for MCP_NEGATIVE_VERIFY_MS without another call. Verify is
 * read-only on chain, so without this one zero-balance payload could be replayed into unlimited RPC reads.
 */
export function guardedVerify(rs: x402ResourceServer, now: () => number = Date.now): x402ResourceServer {
  const inflight = new Map<string, Promise<unknown>>();
  const refused = new Map<string, { at: number; r: unknown }>();
  const keyOf = (p: unknown) => createHash("sha256").update(JSON.stringify(p) ?? "").digest("hex");
  const verify = async (...args: unknown[]) => {
    const k = keyOf(args[0]);
    const hit = refused.get(k);
    if (hit && now() - hit.at < MCP_NEGATIVE_VERIFY_MS) return hit.r;
    const running = inflight.get(k);
    if (running) return running;
    const p = (async () => {
      try {
        const r = await (rs.verifyPayment as (...a: unknown[]) => Promise<unknown>).apply(rs, args);
        if (!(r as { isValid?: boolean } | null)?.isValid) {
          if (refused.size > 10_000) refused.clear();
          refused.set(k, { at: now(), r });
        }
        return r;
      } finally {
        inflight.delete(k);
      }
    })();
    inflight.set(k, p);
    return p;
  };
  return new Proxy(rs, {
    get(t, prop) {
      if (prop === "verifyPayment") return verify;
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

const unavailable: CallToolResult = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "X402_PAYMENTS_UNAVAILABLE", message: "payments unavailable" } }) }], structuredContent: { error: { code: "X402_PAYMENTS_UNAVAILABLE", message: "payments unavailable" } } };

export const MCP_NAME = "capstan";

export function buildServer(deps: McpAppDeps, ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: MCP_NAME, version: deps.version }, { capabilities: { tools: {} } });
  for (const t of deps.tools ?? allTools()) {
    const free = async (args: unknown) => t.handler(args, ctx);
    let base: (args: unknown, extra: unknown) => Promise<unknown> = free;
    if (t.priced) {
      // a paid call is never served free: with payments off it answers "payments unavailable"
      // (no rail left, facilitator unreachable or the rail state unreadable answers the same: fail closed)
      const p = deps.payments;
      const paid = p
        ? async (args: unknown, extra: unknown) => {
            let accepts: PaymentRequirements[];
            try {
              accepts = await p.accepts(t);
            } catch {
              return unavailable;
            }
            if (!accepts.length) return unavailable;
            const run = createPaymentWrapper(p.resourceServer, { accepts, resource: { description: t.description, mimeType: "application/json" } })(async (a) => (await t.handler(a, { ...ctx, auth: { ...ctx.auth, internal: p.internalToken } })) as never);
            return run(args as Record<string, unknown>, extra as never);
          }
        : null;
      base = async (args, extra) => (isPaidCall(t, args) ? (paid ? paid(args, extra) : unavailable) : free(args));
    }
    const counted: typeof base = async (args, extra) => (SERVICE_METRICS.mcpToolCalls.inc(t.name), base(args, extra));
    const cb = deps.wrap ? deps.wrap(t, counted) : counted;
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: z.object(t.inputSchema).strict(), ...(t.outputSchema ? { outputSchema: z.object(t.outputSchema) } : {}), annotations: t.annotations },
      cb as never,
    );
  }
  return server;
}

function defaultIp(c: import("hono").Context): string | null {
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** The JSON-RPC messages of a POST body (one or a batch); [] when it is not JSON. Reads a clone. */
async function rpcMessages(req: Request): Promise<unknown[]> {
  if (req.method !== "POST") return [];
  try {
    const body = (await req.clone().json()) as unknown;
    return Array.isArray(body) ? body : [body];
  } catch {
    return [];
  }
}

const isPaidMessage = (m: unknown): boolean => {
  const x = m as { method?: unknown; params?: { _meta?: Record<string, unknown> } } | null;
  return x?.method === "tools/call" && !!x.params?._meta && "x402/payment" in x.params._meta;
};

const rpcRefusal = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });

export function createMcpApp(deps: McpAppDeps): Hono {
  const app = new Hono();
  const now = deps.rateLimit?.now ?? Date.now;
  const take = windowLimiter(now);
  const perMin = deps.rateLimit?.perMin ?? MCP_RATE_LIMIT_PER_MIN;
  const paidPerMin = deps.rateLimit?.paidPerMin ?? MCP_PAID_PER_MIN;
  if (deps.payments) deps = { ...deps, payments: { ...deps.payments, resourceServer: guardedVerify(deps.payments.resourceServer, now) } };
  app.get("/health", (c) => c.json({ ok: true, service: "mcp" }));
  app.all("/mcp", async (c) => {
    const bearer = c.req.header("authorization");
    const ip = deps.clientIpOf ? deps.clientIpOf(c) : defaultIp(c);
    // r1 F-1: limits per IP bucket before any server is built or any payment is checked
    const msgs = await rpcMessages(c.req.raw);
    const paidCount = msgs.filter(isPaidMessage).length;
    if (paidCount > MCP_MAX_PAID_PER_BATCH) return c.json(rpcRefusal(-32600, `A batch may carry at most ${MCP_MAX_PAID_PER_BATCH} paid tool calls.`), 400);
    const bucket = ipBucket(ip ?? "");
    const wait = take(`all:${bucket}`, Math.max(1, msgs.length), perMin) ?? (paidCount ? take(`paid:${bucket}`, paidCount, paidPerMin) : null);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return c.json(rpcRefusal(-32000, "Too many requests. Slow down and try again."), 429);
    }
    const ctx: ToolCtx = { api: deps.api, auth: { ...(bearer ? { bearer } : {}), ...(ip ? { clientIp: ip } : {}) } };
    const t0 = Date.now();
    const methods = deps.requestLog ? await rpcMethods(c.req.raw) : [];
    const server = buildServer(deps, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: deps.allowedHosts, allowedOrigins: deps.allowedOrigins });
    await server.connect(transport);
    let status = 500;
    try {
      const res = await transport.handleRequest(c.req.raw);
      status = res.status;
      return res;
    } finally {
      void server.close().catch(() => undefined);
      if (deps.requestLog) logRpc(deps.requestLog, methods, { bearer, ip, status, t0 });
    }
  });
  return app;
}

/** JSON-RPC method names in a POST body (one message or a batch); [] when it is not JSON-RPC. Reads a clone. */
export async function rpcMethods(req: Request): Promise<string[]> {
  if (req.method !== "POST") return [];
  try {
    const body = (await req.clone().json()) as unknown;
    const msgs = Array.isArray(body) ? body : [body];
    return msgs.map((m) => (m && typeof m === "object" && typeof (m as { method?: unknown }).method === "string" ? (m as { method: string }).method : null)).filter((m): m is string => !!m && m.length <= 64);
  } catch {
    return [];
  }
}

function logRpc(rl: NonNullable<McpAppDeps["requestLog"]>, methods: string[], o: { bearer?: string; ip: string | null; status: number; t0: number }): void {
  try {
    // the bearer (an API key) is hashed twice and never kept: sha256 here, then the daily salted hash
    const id = o.bearer ? `key:${createHash("sha256").update(o.bearer).digest("hex")}` : o.ip ? `ip:${o.ip}` : null;
    const clientHash = id ? rl.hash(id) : null;
    for (const route of methods) rl.sink.write({ service: "mcp", route, clientHash, ip: o.ip, ipCountry: null, status: o.status, durationMs: Date.now() - o.t0, ts: new Date(o.t0) });
  } catch {
    // the log never fails a call
  }
}
