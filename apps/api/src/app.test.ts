import { expect, test } from "bun:test";
import { app } from "./app";

test("GET /v1/health answers ok", async () => {
  const res = await app.request("/v1/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, service: "api" });
});
