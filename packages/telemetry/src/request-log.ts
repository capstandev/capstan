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

/**
 * Client ids hashed with a salt that lives only in this process's memory and changes every UTC day. Unique clients
 * per day stay countable, but a stored hash can never be linked to another day or reversed later (not even for an
 * IP-derived id, whose raw IP is gone after 7 days). A restart mid-day can count one client twice that day.
 */
export function dailyClientHasher(now: () => Date = () => new Date()): (clientId: string) => string {
  let day = "";
  let salt = "";
  return (clientId) => {
    const d = now().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      salt = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
    }
    return hashClient(clientId, salt);
  };
}

/** A request log row ready to insert: the client id is already hashed (raw ids never reach the sink). */
export interface RequestLogRow {
  service: RequestLogInput["service"];
  route: string;
  clientHash: string | null;
  ip: string | null;
  ipCountry: string | null;
  status: number;
  durationMs: number | null;
  ts: Date;
}

export interface RequestLogSink {
  write(r: RequestLogRow): void;
  /** Insert what is buffered now (also runs on a timer and when the buffer is full). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Buffered writer for request_logs: requests never wait on it. Rows are inserted in batches every flushMs or at
 * maxBatch rows; a failed insert is reported to onError and dropped (a log row is never worth a failed request), and
 * the buffer is capped so a database outage cannot grow memory without bound.
 */
export function bufferedRequestLog(db: Db, o: { flushMs?: number; maxBatch?: number; maxBuffer?: number; onError?: (e: Error, dropped: number) => void } = {}): RequestLogSink {
  const maxBatch = o.maxBatch ?? 200;
  const maxBuffer = o.maxBuffer ?? 10_000;
  let buf: RequestLogRow[] = [];
  let inflight: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (!buf.length) return inflight;
    const rows = buf;
    buf = [];
    inflight = inflight.then(async () => {
      for (let i = 0; i < rows.length; i += maxBatch) {
        const part = rows.slice(i, i + maxBatch);
        try {
          await db.insert(schema.requestLogs).values(part.map((r) => ({ id: ulid(), ...r })));
        } catch (e) {
          o.onError?.(e as Error, part.length);
        }
      }
    });
    return inflight;
  };
  const timer = setInterval(() => void flush(), o.flushMs ?? 1_000);
  (timer as { unref?: () => void }).unref?.();
  return {
    write(r) {
      if (buf.length >= maxBuffer) {
        o.onError?.(new Error("request log buffer full"), 1);
        return;
      }
      buf.push(r);
      if (buf.length >= maxBatch) void flush();
    },
    flush,
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
