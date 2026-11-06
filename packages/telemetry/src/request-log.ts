// Request log rows for api and mcp calls (rate-limit and usage reads). The client id is stored only as a salted
// hash; the IP is kept 7 days at most (log-retention nulls it, ip_country stays).
import { ulid, type Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { createHash } from "node:crypto";

export interface RequestLogInput {
  service: "api" | "mcp";
  route: string;
  clientId?: string | null; // API key id, MCP session client id or wallet; hashed before storage
  ip?: string | null;
  ipCountry?: string | null;
  status: number;
  durationMs?: number;
  ts?: Date;
}

/** Salted sha256 of a client id, cut to 16 hex characters (short, not reversible, stable per salt). */
export function hashClient(clientId: string, salt: string): string {
  if (!salt) throw new Error("hashClient: a salt is required");
  return createHash("sha256").update(`${salt}:${clientId.toLowerCase()}`).digest("hex").slice(0, 16);
}

export async function insertRequestLog(db: Db, r: RequestLogInput, salt: string): Promise<string> {
  const id = ulid();
  await db.insert(schema.requestLogs).values({
    id,
    ts: r.ts ?? new Date(),
    service: r.service,
    route: r.route,
    clientHash: r.clientId ? hashClient(r.clientId, salt) : null,
    ip: r.ip ?? null,
    ipCountry: r.ipCountry ?? null,
    status: r.status,
    durationMs: r.durationMs === undefined ? null : Math.round(r.durationMs),
  });
  return id;
}
