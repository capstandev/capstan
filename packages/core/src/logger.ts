// JSON-lines logger. Redacts any field named sig, signature, password, token, key* (and apiKey, secret-like names),
// and shortens every run of 64 or more hex digits, so no key, signature or full hash reaches a log line.
export type Level = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEY = /^(sig|sigs|signature|signatures|password|passphrase|token|tokens|authorization|cookie|key.*|.*(apikey|api_key|secret|privatekey|private_key|mnemonic|seed|password).*)$/i;
const LONG_HEX = /(0x)?[0-9a-fA-F]{64,}/g;
export const REDACTED = "[redacted]";

function shortenHex(s: string): string {
  return s.replace(LONG_HEX, (m) => `${m.slice(0, m.startsWith("0x") ? 6 : 4)}..${m.slice(-4)}`);
}

/** Deep copy with redaction applied (exported for tests and for code that must log a payload). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return shortenHex(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: shortenHex(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function logger(
  service: string,
  opts?: { level?: Level; sink?: (line: string) => void; base?: Record<string, unknown> },
): Logger {
  const min = LEVELS[opts?.level ?? ((process.env.LOG_LEVEL as Level) || "info")] ?? LEVELS.info;
  const sink = opts?.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const base = opts?.base ?? {};
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const rec = { ts: new Date().toISOString(), level, service, msg: shortenHex(msg), ...(redact({ ...base, ...fields }) as object) };
    sink(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (f) => logger(service, { level: opts?.level, sink, base: { ...base, ...f } }),
  };
}
