// tRPC v11 router on /trpc/* (typed internal and SDK calls). Only `ping` exists; later work adds procedures.
import { trpcServer } from "@hono/trpc-server";
import { initTRPC } from "@trpc/server";
import type { Hono } from "hono";

const t = initTRPC.create();

export const appRouter = t.router({
  ping: t.procedure.query(() => ({ pong: true as const })),
});

export type AppRouter = typeof appRouter;

export function mountTrpc(app: Hono): void {
  app.use("/trpc/*", trpcServer({ router: appRouter, endpoint: "/trpc" }));
}
