// GET /v1/health: liveness only (no dependency checks, no data).
import type { RouteSpec } from "@capstan/core";

export const routes: RouteSpec[] = [
  {
    method: "GET",
    path: "/health",
    auth: "public",
    description: "Liveness check",
    handler: (c) => c.json({ ok: true, service: "api" }),
  },
];
