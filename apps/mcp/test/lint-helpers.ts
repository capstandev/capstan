// Lint helpers for the MCP tool schemas and copy (used by schema-lint and copy tests).
import { z } from "zod";
import { loadAllowed, loadBanned, stripAllowed } from "../../../ops/ci/check-banned-words";
import type { ToolDef } from "../src/tools/types";

const KEY_NAME = new RegExp(["priv" + "ate", "sec" + "ret", "se" + "ed", "mne" + "monic", "pass" + "phrase", "api" + "Secret"].join("|"), "i");

/** Every property name in a JSON schema, at any depth (objects, arrays, unions, records). */
export function propertyNames(s: unknown, out: string[] = []): string[] {
  if (Array.isArray(s)) s.forEach((x) => propertyNames(x, out));
  else if (s && typeof s === "object") {
    const o = s as Record<string, unknown>;
    if (o.properties && typeof o.properties === "object") for (const k of Object.keys(o.properties)) out.push(k);
    if (Array.isArray(o.required)) for (const k of o.required) if (typeof k === "string") out.push(k);
    for (const v of Object.values(o)) propertyNames(v, out);
  }
  return out;
}

export function lintTools(tools: ToolDef[]): { tool: string; field: string }[] {
  const bad: { tool: string; field: string }[] = [];
  for (const t of tools) {
    for (const shape of [t.inputSchema, t.outputSchema].filter(Boolean) as z.ZodRawShape[]) {
      const names = propertyNames(z.toJSONSchema(z.object(shape), { unrepresentable: "any" }));
      for (const n of new Set(names)) if (KEY_NAME.test(n)) bad.push({ tool: t.name, field: n });
    }
  }
  return bad;
}


export function descriptions(s: unknown, out: string[] = []): string[] {
  if (Array.isArray(s)) s.forEach((x) => descriptions(x, out));
  else if (s && typeof s === "object") for (const [k, v] of Object.entries(s as Record<string, unknown>)) (k === "description" && typeof v === "string" ? out.push(v) : descriptions(v, out));
  return out;
}

export function copyOf(tools: ToolDef[]): string[] {
  return tools.flatMap((t) => [t.description, ...descriptions(z.toJSONSchema(z.object(t.inputSchema), { unrepresentable: "any" })), ...(t.outputSchema ? descriptions(z.toJSONSchema(z.object(t.outputSchema), { unrepresentable: "any" })) : [])]);
}

export function bannedIn(texts: string[]): string[] {
  const banned = loadBanned();
  const allowed = loadAllowed();
  return texts.filter((t) => banned.some((re) => re.test(stripAllowed(t, allowed))) || /\bvpn|prox(y|ies)|workaround|get around|bypass/i.test(t));
}

