import { useEffect, useState } from "react";
import { Disclaimer } from "../components/Disclaimer";
import { Table } from "../components/Table";

export interface OpenApiDoc {
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, { operationId?: string; summary?: string; security?: Record<string, unknown>[]; "x-price-usd"?: string }>>;
}

export interface McpToolRow {
  tool: string;
  input: string;
  output: string;
}

const AUTH: Record<string, string> = { ownerSignature: "Owner signature", apiKey: "API key", x402: "x402 payment", internal: "Internal" };

export function authOf(security: Record<string, unknown>[] | undefined): string {
  if (!security || security.length === 0) return "None";
  return security.map((s) => Object.keys(s).map((k) => AUTH[k] ?? k).join(" and ")).join(" or ");
}

export function operations(doc: OpenApiDoc) {
  const out: { method: string; path: string; summary: string; auth: string; price: string }[] = [];
  for (const path of Object.keys(doc.paths).sort()) {
    for (const [method, op] of Object.entries(doc.paths[path]!)) {
      out.push({ method: method.toUpperCase(), path, summary: op.summary ?? "", auth: authOf(op.security), price: op["x-price-usd"] ? `$${op["x-price-usd"]}` : "Free" });
    }
  }
  return out;
}

/** /docs: the generated OpenAPI file (synced at build time from apps/api/openapi.json) and the MCP tool table. */
export function ApiDocs({ doc: given, tools: givenTools }: { doc?: OpenApiDoc; tools?: McpToolRow[] }) {
  const [doc, setDoc] = useState<OpenApiDoc | null>(given ?? null);
  const [tools, setTools] = useState<McpToolRow[] | null>(givenTools ?? null);
  useEffect(() => {
    if (given && givenTools) return;
    let alive = true;
    void Promise.all([import("../generated/openapi.json"), import("../generated/mcp-tools.json")]).then(([a, t]) => {
      if (!alive) return;
      setDoc((a as { default: OpenApiDoc }).default);
      setTools((t as { default: McpToolRow[] }).default);
    });
    return () => {
      alive = false;
    };
  }, [given, givenTools]);
  return (
    <article className="page">
      <h1>API docs</h1>
      <p>Every write endpoint returns an unsigned payload. Nothing accepts a private key. Your SDK or agent host signs locally.</p>
      <Disclaimer />
      {doc ? (
        <section aria-labelledby="rest-title" data-openapi-version={doc.info.version}>
          <h2 id="rest-title">
            REST ({doc.info.title} {doc.info.version})
          </h2>
          {doc.info.description ? <p>{doc.info.description}</p> : null}
          <p>
            Base URL: <code>{`${doc.servers?.[0]?.url ?? ""}/v1`}</code>
          </p>
          <Table label="REST endpoints" className="ops" head={["Method", "Path", "What it does", "Auth", "Price"]} rows={operations(doc).map((o) => [<code key="m">{o.method}</code>, <code key="p">{o.path}</code>, o.summary, o.auth, o.price])} />
        </section>
      ) : (
        <p role="status">Loading the API description.</p>
      )}
      {tools ? (
        <section aria-labelledby="mcp-title">
          <h2 id="mcp-title">MCP tools</h2>
          <p>Streamable HTTP. Read only unless a write tool is called. No tool accepts a key: builds return unsigned payloads that your host signs with the SDK.</p>
          <Table label="MCP tools" head={["Tool", "Input", "Output"]} rows={tools.map((t) => [<code key="t">{t.tool}</code>, t.input, t.output])} />
        </section>
      ) : null}
    </article>
  );
}
