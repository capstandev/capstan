// GET /v1/openapi.json: the generated OpenAPI 3.1 document (apps/api/openapi.json, written by `bun run openapi`; a
// test keeps the committed file equal to a fresh generation). Read once, served as is.
import type { RouteSpec } from "@capstan/core";
import { join } from "node:path";

export const OPENAPI_PATH = join(import.meta.dir, "../../openapi.json");

let doc: Promise<string> | null = null;

export const routes: RouteSpec[] = [
  {
    method: "GET",
    path: "/openapi.json",
    auth: "public",
    description: "The OpenAPI 3.1 document for this API",
    handler: async (c) => {
      const body = await (doc ??= Bun.file(OPENAPI_PATH).text());
      return c.body(body, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" });
    },
  },
];
