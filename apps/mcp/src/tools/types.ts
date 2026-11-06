// Tool contract for the Capstan MCP server. Each tool is a thin call into the public API.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { CallAuth, CapstanApiClient } from "../client";

export interface ToolCtx {
  api: CapstanApiClient;
  auth: CallAuth;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: true };
  /** Paid tools (32): the x402 price in USD, charged through @x402/mcp. */
  priced?: { usd: string };
  handler(input: unknown, ctx: ToolCtx): Promise<CallToolResult>;
}

/** Turn an API answer into a tool result: the API's JSON as both structured content and text. */
export function fromApi(a: { status: number; body: unknown }): CallToolResult {
  const body = a.body && typeof a.body === "object" && !Array.isArray(a.body) ? (a.body as Record<string, unknown>) : { result: a.body };
  const isError = a.status >= 400;
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, ...(isError ? { isError: true } : {}) };
}
