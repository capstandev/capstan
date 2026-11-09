// Stand-in Telegram Bot API for tests: a local HTTP server that records every sendMessage and sendPhoto call and
// answers like Telegram does. Responses can be scripted per call (a 429 with retry_after, a 500), so the alert code
// can be proven end to end without a real bot, a real group or a network. It never forwards anything anywhere.
//
// In a test:   const s = startTelegramStandin({ port: 24740 }); ... s.calls ... s.stop();
// From a shell: bun ops/alerts/telegram-standin.ts --port 24742 --record /path/calls.jsonl [--script 429:1,500]
//   (one JSON line per call; the token in the path is replaced by its length, never written out; --script answers
//   the first calls with these statuses, in order, "429:N" meaning a 429 with retry_after N, then 200 for the rest)

export type StandinMethod = "sendMessage" | "sendPhoto";

export interface StandinCall {
  method: StandinMethod | string;
  /** Milliseconds since the epoch when the call arrived. */
  at: number;
  /** Length of the bot token in the path (the token itself is not kept). */
  tokenLength: number;
  chatId: string;
  /** sendMessage text or sendPhoto caption. */
  text: string;
  /** sendPhoto only: byte length of the uploaded photo, or the photo URL / file id. */
  photo?: string | number;
  /** The status the stand-in answered with. */
  status: number;
}

export interface ScriptedReply {
  status: number;
  /** Telegram's parameters.retry_after for a 429. */
  retryAfter?: number;
  description?: string;
}

export interface TelegramStandin {
  port: number;
  url: string;
  calls: StandinCall[];
  /** Calls the stand-in answered with 200 (what the group would have shown). */
  delivered(method?: StandinMethod): StandinCall[];
  /** Answer the next calls with these replies, in order; after them every call gets 200. */
  script(...replies: ScriptedReply[]): void;
  reset(): void;
  stop(): void;
}

/** Parse a --script value ("429:1,500,200") into scripted replies. Throws on anything that is not a status. */
export function parseScript(spec: string): ScriptedReply[] {
  if (spec.trim() === "") return [];
  return spec.split(",").map((part) => {
    const m = /^\s*([1-5][0-9][0-9])(?::([0-9]+))?\s*$/.exec(part);
    if (!m) throw new Error(`bad --script entry: ${part}`);
    const reply: ScriptedReply = { status: Number(m[1]) };
    if (m[2] !== undefined) reply.retryAfter = Number(m[2]);
    return reply;
  });
}

const PATH = /^\/bot([^/]+)\/([A-Za-z]+)$/;

async function readBody(req: Request): Promise<{ chatId: string; text: string; photo?: string | number }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return { chatId: String(j.chat_id ?? ""), text: String(j.text ?? j.caption ?? ""), ...(j.photo !== undefined ? { photo: String(j.photo) } : {}) };
  }
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const f = await req.formData();
    const photo = f.get("photo");
    const out: { chatId: string; text: string; photo?: string | number } = { chatId: String(f.get("chat_id") ?? ""), text: String(f.get("text") ?? f.get("caption") ?? "") };
    if (photo !== null) out.photo = typeof photo === "string" ? photo : (photo as Blob).size;
    return out;
  }
  const q = new URL(req.url).searchParams;
  return { chatId: q.get("chat_id") ?? "", text: q.get("text") ?? q.get("caption") ?? "" };
}

export function startTelegramStandin(o: { port?: number; hostname?: string; onCall?: (c: StandinCall) => void } = {}): TelegramStandin {
  const calls: StandinCall[] = [];
  let queue: ScriptedReply[] = [];
  let messageId = 0;
  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: o.hostname ?? "127.0.0.1",
    async fetch(req) {
      const m = PATH.exec(new URL(req.url).pathname);
      if (!m || req.method !== "POST") return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      const [, token, method] = m as unknown as [string, string, string];
      const body = await readBody(req);
      const reply = queue.shift() ?? { status: 200 };
      const call: StandinCall = { method, at: Date.now(), tokenLength: token.length, chatId: body.chatId, text: body.text, ...(body.photo !== undefined ? { photo: body.photo } : {}), status: reply.status };
      calls.push(call);
      o.onCall?.(call);
      if (method !== "sendMessage" && method !== "sendPhoto") return Response.json({ ok: false, error_code: 404, description: "Not Found: method not in the stand-in" }, { status: 404 });
      if (reply.status === 200) return Response.json({ ok: true, result: { message_id: ++messageId, chat: { id: Number(body.chatId) || 0 }, date: Math.floor(call.at / 1000), ...(method === "sendMessage" ? { text: body.text } : { caption: body.text }) } });
      if (reply.status === 429) {
        const after = reply.retryAfter ?? 1;
        return Response.json({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${after}`, parameters: { retry_after: after } }, { status: 429, headers: { "retry-after": String(after) } });
      }
      return Response.json({ ok: false, error_code: reply.status, description: reply.description ?? "stand-in error" }, { status: reply.status });
    },
  });
  const port = server.port as number;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    calls,
    delivered: (method) => calls.filter((c) => c.status === 200 && (method === undefined || c.method === method)),
    script: (...replies) => {
      queue.push(...replies);
    },
    reset: () => {
      calls.length = 0;
      queue = [];
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const { appendFileSync } = await import("node:fs");
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const port = Number(arg("--port") ?? 0);
  const record = arg("--record");
  const scripted = parseScript(arg("--script") ?? "");
  const s = startTelegramStandin({ port, onCall: (c) => record && appendFileSync(record, JSON.stringify(c) + "\n") });
  if (scripted.length > 0) s.script(...scripted);
  process.stdout.write(`telegram stand-in listening on ${s.url}\n`);
  const stop = () => (s.stop(), process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
