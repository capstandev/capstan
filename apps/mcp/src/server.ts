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
    const cb = deps.wrap ? deps.wrap(t, base) : base;
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

export function createMcpApp(deps: McpAppDeps): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, service: "mcp" }));
  app.all("/mcp", async (c) => {
    const bearer = c.req.header("authorization");
    const ip = deps.clientIpOf ? deps.clientIpOf(c) : defaultIp(c);
    const ctx: ToolCtx = { api: deps.api, auth: { ...(bearer ? { bearer } : {}), ...(ip ? { clientIp: ip } : {}) } };
    const server = buildServer(deps, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: deps.allowedHosts, allowedOrigins: deps.allowedOrigins });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => undefined);
    }
  });
  return app;
}
