// OpenAPI 3.1, generated (never hand written) from the mounted RouteSpecs and the zod input schemas of
// @capstan/schema (API_INPUT_SCHEMAS). `bun run openapi` writes apps/api/openapi.json for the web docs; a test fails
// when the committed file differs from a fresh generation.
import type { RouteAuth, RouteSpec } from "@capstan/core";
import { API_INPUT_SCHEMAS, ERROR_CODES } from "@capstan/schema";
import { z } from "zod";

export const OPENAPI_VERSION = "3.1.0";
export const API_VERSION = "1.0.0";

const toOpenPath = (p: string) => p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
const pathParams = (p: string) => [...p.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);

function jsonSchema(s: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(s, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

const SECURITY: Record<RouteAuth, Record<string, string[]>[]> = {
  public: [],
  owner_sig: [{ ownerSignature: [] }],
  api_key: [{ apiKey: [] }],
  x402: [{ x402: [] }],
  internal: [{ internal: [] }],
};

const RESPONSES_BY_AUTH: Record<RouteAuth, string[]> = { public: [], owner_sig: ["401"], api_key: ["401"], x402: ["402", "503"], internal: ["401"] };

export function generateOpenApi(specs: Pick<RouteSpec, "method" | "path" | "auth" | "authAlt" | "priced" | "description" | "write">[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...specs].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  for (const s of sorted) {
    const op = toOpenPath(s.path);
    const key = `${s.method} ${op}` as keyof typeof API_INPUT_SCHEMAS;
    const input = API_INPUT_SCHEMAS[key] as z.ZodType | undefined;
    const params: Record<string, unknown>[] = pathParams(s.path).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
    let requestBody: Record<string, unknown> | undefined;
    if (input) {
      const js = jsonSchema(input);
      if (s.method === "GET") {
        const props = (js.properties ?? {}) as Record<string, unknown>;
        const req = new Set((js.required ?? []) as string[]);
        for (const [name, schema] of Object.entries(props)) if (!params.some((p) => p.name === name)) params.push({ name, in: "query", required: req.has(name), schema });
      } else requestBody = { required: true, content: { "application/json": { schema: js } } };
    }
    const errs = new Set<string>(["400", "429", ...RESPONSES_BY_AUTH[s.auth], ...(s.authAlt ?? []).flatMap((a) => RESPONSES_BY_AUTH[a]), ...(s.write ? ["403"] : [])]);
    const responses: Record<string, unknown> = { "200": { description: "OK", content: { "application/json": { schema: {} } } } };
    for (const code of [...errs].sort()) responses[code] = { description: code === "402" ? "Payment required (x402)" : "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } };
    paths[`/v1${op}`] ??= {};
    paths[`/v1${op}`]![s.method.toLowerCase()] = {
      operationId: `${s.method.toLowerCase()}${op.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+(.)?/g, (_m, ch: string | undefined) => (ch ? ch.toUpperCase() : ""))}`,
      summary: s.description ?? `${s.method} ${op}`,
      security: [...SECURITY[s.auth], ...(s.authAlt ?? []).flatMap((a) => SECURITY[a])],
      ...(s.priced ? { "x-price-usd": s.priced.usd } : {}),
      ...(s.write ? { "x-eligibility": s.write.action } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
    };
  }
  return {
    openapi: OPENAPI_VERSION,
    info: { title: "Capstan API", version: API_VERSION, description: "Non-custodial multi-venue perps API. Every write endpoint returns an unsigned payload; nothing accepts a private key. Each venue liquidates independently." },
    servers: [{ url: "https://api.get-capstan.com" }],
    paths,
    components: {
      securitySchemes: {
        ownerSignature: { type: "apiKey", in: "header", name: "x-capstan-signature", description: "EIP-191 signature of the Capstan message (base64 in x-capstan-message), purpose api_request" },
        apiKey: { type: "http", scheme: "bearer", description: "Capstan API key" },
        x402: { type: "apiKey", in: "header", name: "PAYMENT-SIGNATURE", description: "x402 v2 payment" },
        internal: { type: "apiKey", in: "header", name: "x-capstan-internal" },
      },
      schemas: {
        ErrorBody: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string", enum: Object.keys(ERROR_CODES) }, message: { type: "string" }, receiptId: { type: "string" } } } },
        },
      },
    },
  };
}
