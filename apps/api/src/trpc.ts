// tRPC v11 router on /trpc/* (typed SDK calls). Every procedure mirrors one public read route: it calls the same REST
// route inside this app (same auth, rate limits and errors), so the two never drift. Writes stay REST only.
import { trpcServer } from "@hono/trpc-server";
import { BookQueryZ, FundingQueryZ, MarketsQueryZ } from "@capstan/schema";
import { initTRPC, TRPCError } from "@trpc/server";
import type { Context as HonoContext, Hono } from "hono";
import { z } from "zod";

type TrpcCtx = {
  call(path: string, query?: Record<string, string | undefined>): Promise<unknown>;
  [k: string]: unknown;
};

const t = initTRPC.context<TrpcCtx>().create();
const STATUS: Record<number, TRPCError["code"]> = { 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 402: "PAYMENT_REQUIRED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 429: "TOO_MANY_REQUESTS", 503: "SERVICE_UNAVAILABLE" };

const qs = (o: Record<string, unknown>): Record<string, string | undefined> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? undefined : String(v)]));

export const appRouter = t.router({
  ping: t.procedure.query(() => ({ pong: true as const })),
  venues: t.procedure.query(({ ctx }) => ctx.call("/v1/venues")),
  markets: t.procedure.input(MarketsQueryZ.partial().optional()).query(({ ctx, input }) => ctx.call("/v1/markets", qs((input ?? {}) as Record<string, unknown>))),
  book: t.procedure.input(BookQueryZ.partial({ depth: true })).query(({ ctx, input }) => ctx.call(`/v1/markets/${encodeURIComponent(input.id)}/book`, qs({ depth: input.depth }))),
  funding: t.procedure.input(FundingQueryZ).query(({ ctx, input }) => ctx.call("/v1/funding", qs(input))),
  eligibility: t.procedure.input(z.object({ venue: z.string().max(32), owner: z.string().max(42).optional() })).query(({ ctx, input }) => ctx.call("/v1/eligibility", qs(input))),
  receipt: t.procedure.input(z.object({ id: z.string().min(1).max(64) })).query(({ ctx, input }) => ctx.call(`/v1/receipts/${encodeURIComponent(input.id)}`)),
  receiptProof: t.procedure.input(z.object({ id: z.string().min(1).max(64) })).query(({ ctx, input }) => ctx.call(`/v1/receipts/${encodeURIComponent(input.id)}/proof`)),
  receiptVerify: t.procedure.input(z.object({ id: z.string().min(1).max(64) })).query(({ ctx, input }) => ctx.call(`/v1/receipts/${encodeURIComponent(input.id)}/verify`)),
});

export type AppRouter = typeof appRouter;

/** The REST routes the router mirrors (a test keeps this list equal to the procedures). */
export const TRPC_MIRRORS = ["/venues", "/markets", "/markets/:id/book", "/funding", "/eligibility", "/receipts/:id", "/receipts/:id/proof", "/receipts/:id/verify"] as const;

/**
 * Most procedures one batched request may name (r1:3 F5). Each one is an internal call through the full /v1 chain
 * (request log, rate limiter, handler), so an unbounded batch was a fan-out amplifier.
 */
export const TRPC_MAX_BATCH = 10;

export function mountTrpc(app: Hono, _mounted?: unknown): void {
  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      endpoint: "/trpc",
      maxBatchSize: TRPC_MAX_BATCH,
      createContext: (_opts, c: HonoContext): TrpcCtx => ({
        async call(path, query) {
          const u = new URL(path, c.req.url);
          for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
          const res = await app.fetch(new Request(u, { headers: c.req.raw.headers }), c.env);
          const body = await res.json().catch(() => null);
          if (!res.ok) throw new TRPCError({ code: STATUS[res.status] ?? "INTERNAL_SERVER_ERROR", message: (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`, cause: body });
          return body;
        },
      }),
    }),
  );
}
