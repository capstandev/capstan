// Ops alerts to the internal Telegram group (DECISIONS #12). Plain text in four parts: what happened, who is
// affected, what was done, what is next, plus the glossary cause. Rules:
//   - unarmed (ALERTS_ARMED unset) or no token file: the alert is logged, never sent ('logged')
//   - armed: one message per cause per 30 minutes ('deduped' inside the window)
//   - the bot token is read from a chmod-600 file at send time, used only inside the request URL, and never appears
//     in a log line, an error message or process arguments (no child process is spawned)
//   - text carries no user identifier: wallet addresses become a short hash unless they are known service addresses,
//     IPs become [ip], long hex is hashed
//   - text longer than 3,600 characters is split at line ends into numbered parts "(1/3) ..." of at most 3,600
//     characters each (Telegram caps at 4,096), up to MAX_ALERT_PARTS; past that the last part ends with "+N more"
//   - a 429 from Telegram is retried after its retry_after (body parameters.retry_after, else the Retry-After header),
//     at most MAX_429_RETRIES times and only when the wait is at most MAX_RETRY_WAIT_S; otherwise the send fails
// Alerts only notify. Nothing in this module can pause, stop or kill anything (MON-1).
import type { Logger } from "@capstan/core";
import { readFileSync, statSync } from "node:fs";
import type { OpsAlert } from "./causes";
import { b64sha256, scrubHex } from "./redact";
import { isIP } from "node:net";

export type { OpsAlert } from "./causes";

export const MAX_ALERT_CHARS = 3600;
/** At most this many messages per alert; the rest of a longer text is counted as "+N more". */
export const MAX_ALERT_PARTS = 4;
/** A 429 is retried at most this many times per message. */
export const MAX_429_RETRIES = 2;
/** A 429 that asks for a longer wait is not waited for (the worker runs every 15 s); the send fails instead. */
export const MAX_RETRY_WAIT_S = 30;

export interface DedupeStore {
  /** True when the key was free and is now held for ttlMs; false when it is already held. */
  claim(key: string, ttlMs: number, nowMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export function memoryDedupe(): DedupeStore {
  const until = new Map<string, number>();
  return {
    async claim(key, ttlMs, nowMs) {
      const u = until.get(key);
      if (u !== undefined && u > nowMs) return false;
      until.set(key, nowMs + ttlMs);
      return true;
    },
    async release(key) {
      until.delete(key);
    },
  };
}

/** Redis-backed dedupe shared by every worker process (SET NX PX). */
export function redisDedupe(redis: { set(key: string, value: string, mode: "PX", ttl: number, nx: "NX"): Promise<unknown>; del(key: string): Promise<unknown> }, prefix = "capstan:ops-alert:dedupe:"): DedupeStore {
  return {
    async claim(key, ttlMs) {
      const r = await redis.set(prefix + key, "1", "PX", Math.max(1, Math.round(ttlMs)), "NX");
      return r === "OK";
    },
    async release(key) {
      await redis.del(prefix + key);
    },
  };
}

export interface SendDeps {
  armed: boolean;
  tokenFile: string;
  chatId: string;
  dedupeMinutes: 30;
  http: typeof fetch;
  apiBase?: string; // default https://api.telegram.org (tests point it at a local fake server)
  now?: () => number;
  /** Wait before a 429 retry (default a real timer). */
  sleep?: (ms: number) => Promise<void>;
  dedupe?: DedupeStore;
  log?: Logger;
  /** Service and builder addresses that may appear in full (the owner funds them). Every other address is hashed. */
  knownAddresses?: readonly string[];
}

const defaultDedupe = memoryDedupe();

export class TelegramSendError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "telegram: send failed (network error)" : `telegram: send failed (status ${status})`);
    this.name = "TelegramSendError";
  }
}

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/** Remove user identifiers from alert text. */
export function sanitizeAlertText(s: string, knownAddresses: readonly string[] = []): string {
  const known = new Set(knownAddresses.map((a) => a.toLowerCase()));
  const noHex = scrubHex(s);
  const noAddr = noHex.replace(ADDRESS, (a) => (known.has(a.toLowerCase()) ? a : `wallet#${b64sha256(a.toLowerCase()).slice(0, 8)}`));
  return noAddr.replace(/[0-9a-fA-F:.]{3,}/g, (t) => (isIP(t.replace(/\.+$/, "")) ? "[ip]" : t));
}

/** Cut at a line end so the text fits in `max` characters, ending with "+N more" (N = lines left out). */
export function truncateAlert(text: string, max = MAX_ALERT_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const n = lines.length;
  let len = 0; // length of lines[0..k) joined
  let k = 0;
  while (k < n) {
    const next = len + (k ? 1 : 0) + lines[k]!.length;
    const left = n - (k + 1);
    if (next + (left ? `\n+${left} more`.length : 0) > max) break;
    len = next;
    k++;
  }
  if (k === n) return lines.join("\n");
  if (k === 0) {
    // the first line alone is too long: cut it and count it as kept
    const suffix = `\n+${n - 1} more`;
    return n > 1 ? lines[0]!.slice(0, max - suffix.length) + suffix : lines[0]!.slice(0, max);
  }
  return `${lines.slice(0, k).join("\n")}\n+${n - k} more`;
}

/** Split at line ends into numbered parts "(i/n) " of at most `max` characters each, at most `maxParts` parts. A line
 * longer than a part is cut into pieces. Past `maxParts` the last part is cut with truncateAlert ("+N more"). */
export function splitAlert(text: string, max = MAX_ALERT_CHARS, maxParts = MAX_ALERT_PARTS): string[] {
  if (text.length <= max) return [text];
  const room = max - "(99/99) ".length;
  const pieces: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= room) pieces.push(line);
    else for (let i = 0; i < line.length; i += room) pieces.push(line.slice(i, i + room));
  }
  const parts: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of pieces) {
    const next = len + (cur.length ? 1 : 0) + p.length;
    if (cur.length && next > room) {
      parts.push(cur.join("\n"));
      cur = [p];
      len = p.length;
    } else {
      cur.push(p);
      len = next;
    }
  }
  if (cur.length) parts.push(cur.join("\n"));
  if (parts.length > maxParts) {
    const rest = parts.slice(maxParts - 1).join("\n");
    parts.length = maxParts - 1;
    parts.push(truncateAlert(rest, room));
  }
  return parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`);
}

function fullAlertText(a: OpsAlert, knownAddresses: readonly string[]): string {
  const head = `[${a.severity.toUpperCase()}] ${a.cause}`;
  const body = [`What happened: ${a.what}`, `Who is affected: ${a.affected}`, `What was done: ${a.done}`, `What is next: ${a.next}`, `Glossary: ops/alerts/GLOSSARY.md#${a.cause}`];
  return sanitizeAlertText([head, ...body].join("\n"), knownAddresses);
}

/** One message of at most MAX_ALERT_CHARS (cut with "+N more"); the log line form. */
export function formatOpsAlert(a: OpsAlert, knownAddresses: readonly string[] = []): string {
  return truncateAlert(fullAlertText(a, knownAddresses));
}

/** The messages an alert is sent as: one, or numbered parts when the text is longer than MAX_ALERT_CHARS. */
export function formatOpsAlertParts(a: OpsAlert, knownAddresses: readonly string[] = []): string[] {
  return splitAlert(fullAlertText(a, knownAddresses));
}

/** Seconds a 429 asks to wait: body parameters.retry_after, else the Retry-After header, else 1. */
async function retryAfterSeconds(res: Response): Promise<number> {
  try {
    const j = (await res.json()) as { parameters?: { retry_after?: unknown } };
    const v = Number(j?.parameters?.retry_after);
    if (Number.isFinite(v) && v >= 0) return v;
  } catch {
    // not JSON: fall back to the header
  }
  const h = Number(res.headers.get("retry-after"));
  return Number.isFinite(h) && h >= 0 ? h : 1;
}

function readToken(file: string): string | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error("telegram: the token file must be a regular file with mode 600");
  const t = readFileSync(file, "utf8").trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error("telegram: the token file does not hold a bot token");
  return t;
}

export async function sendOpsAlert(a: OpsAlert, deps: SendDeps): Promise<"sent" | "deduped" | "logged"> {
  const text = formatOpsAlert(a, deps.knownAddresses);
  const log = deps.log;
  if (!deps.armed) {
    log?.warn("ops alert (not armed, logged only)", { cause: a.cause, severity: a.severity, text });
    return "logged";
  }
  let token: string | null;
  try {
    token = readToken(deps.tokenFile);
  } catch (e) {
    log?.error("ops alert not sent: token file refused", { cause: a.cause, error: (e as Error).message, text });
    return "logged";
  }
  if (!token) {
    log?.warn("ops alert not sent: no token file", { cause: a.cause, text });
    return "logged";
  }
  const now = (deps.now ?? Date.now)();
  const dedupe = deps.dedupe ?? defaultDedupe;
  const key = `cause:${a.cause}`;
  if (!(await dedupe.claim(key, deps.dedupeMinutes * 60_000, now))) {
    log?.info("ops alert deduped", { cause: a.cause });
    return "deduped";
  }
  const base = (deps.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const parts = formatOpsAlertParts(a, deps.knownAddresses);
  const fail = async (status: number | null): Promise<never> => {
    token = null;
    await dedupe.release(key);
    log?.error("ops alert send failed", { cause: a.cause, status });
    throw new TelegramSendError(status);
  };
  for (const part of parts) {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.http(`${base}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: deps.chatId, text: part, disable_web_page_preview: true }),
        });
      } catch {
        return fail(null);
      }
      if (res.ok) break;
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const wait = await retryAfterSeconds(res);
        if (wait <= MAX_RETRY_WAIT_S) {
          log?.warn("ops alert rate limited, retrying", { cause: a.cause, retryAfterS: wait });
          await sleep(Math.ceil(wait * 1000));
          continue;
        }
      }
      return fail(res.status);
    }
  }
  token = null;
  log?.info("ops alert sent", { cause: a.cause, severity: a.severity, parts: parts.length });
  return "sent";
}
