// @capstan/api: Hono REST app. Only the health route exists in the scaffold.
import { Hono } from "hono";

export const app = new Hono().basePath("/v1");

app.get("/health", (c) => c.json({ ok: true, service: "api" }));
