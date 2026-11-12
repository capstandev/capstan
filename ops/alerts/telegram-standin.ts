// Stand-in Telegram Bot API for tests: a local HTTP server that records every sendMessage and sendPhoto call and
// answers like Telegram does. Responses can be scripted per call (a 429 with retry_after, a 500), so the alert code
// can be proven end to end without a real bot, a real group or a network. It never forwards anything anywhere.
//
// In a test:   const s = startTelegramStandin({ port: 24740 }); ... s.calls ... s.stop();
// From a shell: bun ops/alerts/telegram-standin.ts --port 24742 --record /path/calls.jsonl [--script 429:1,500]
//   (one JSON line per call; the token in the path is replaced by its length, never written out; --script answers
//   the first calls with these statuses, in order, "429:N" meaning a 429 with retry_after N, then 200 for the rest)
//
// Inbound side (the team bot, ops/teambot): getUpdates answers from a queue of updates the test pushes (in a test:
// s.pushUpdate({...}); from a shell: POST /__standin/updates with a JSON array, GET /__standin/calls for the record),
// and getMe, getWebhookInfo, answerCallbackQuery, editMessageText and sendVideo answer like Telegram. The script queue
// only ever answers the send methods, so a polling bot never eats a scripted 429.

export type StandinMethod = "sendMessage" | "sendPhoto" | "sendVideo" | "editMessageText" | "answerCallbackQuery";
const SEND_METHODS = new Set(["sendMessage", "sendPhoto", "sendVideo"]);
const RECORDED = new Set(["sendMessage", "sendPhoto", "sendVideo", "editMessageText", "answerCallbackQuery"]);

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
  /** reply_markup as JSON text, when the call carried one (inline buttons). */
  replyMarkup?: string;
  /** editMessageText: the edited message id; answerCallbackQuery: the query id. */
  messageId?: number;
  callbackQueryId?: string;
  /** answerCallbackQuery show_alert. */
  showAlert?: boolean;
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
  /** Queue an inbound update for getUpdates (update_id is filled in when missing). Returns its update_id. */
  pushUpdate(u: Record<string, unknown>): number;
  /** How many getUpdates calls arrived (they are not in calls). */
  polls(): number;
  reset(): void;
  stop(): void;
}

/** The bot the stand-in pretends to be (getMe). */
export const STANDIN_BOT = { id: 7000000001, is_bot: true, first_name: "Capstan team", username: "capstan_team_standin_bot" };

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

interface Body {
  chatId: string;
  text: string;
  photo?: string | number;
  replyMarkup?: string;
  messageId?: number;
  callbackQueryId?: string;
  showAlert?: boolean;
  offset?: number;
  timeout?: number;
}

function extras(get: (k: string) => unknown): Partial<Body> {
  const out: Partial<Body> = {};
  const rm = get("reply_markup");
  if (rm !== undefined && rm !== null) out.replyMarkup = typeof rm === "string" ? rm : JSON.stringify(rm);
  const mid = get("message_id");
  if (mid !== undefined && mid !== null) out.messageId = Number(mid);
  const qid = get("callback_query_id");
  if (qid !== undefined && qid !== null) out.callbackQueryId = String(qid);
  const sa = get("show_alert");
  if (sa !== undefined && sa !== null) out.showAlert = sa === true || sa === "true";
  const off = get("offset");
  if (off !== undefined && off !== null) out.offset = Number(off);
  const to = get("timeout");
  if (to !== undefined && to !== null) out.timeout = Number(to);
  return out;
}

async function readBody(req: Request): Promise<Body> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const media = j.photo ?? j.video;
    return { chatId: String(j.chat_id ?? ""), text: String(j.text ?? j.caption ?? ""), ...(media !== undefined ? { photo: String(media) } : {}), ...extras((k) => j[k]) };
  }
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const f = await req.formData();
    const photo = f.get("photo") ?? f.get("video");
    const out: Body = { chatId: String(f.get("chat_id") ?? ""), text: String(f.get("text") ?? f.get("caption") ?? ""), ...extras((k) => f.get(k) ?? undefined) };
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
  let updates: Record<string, unknown>[] = [];
  let nextUpdateId = 1;
  let polls = 0;
  const pushUpdate = (u: Record<string, unknown>): number => {
    const id = typeof u.update_id === "number" ? u.update_id : nextUpdateId;
    nextUpdateId = Math.max(nextUpdateId, id + 1);
    updates.push({ ...u, update_id: id });
    return id;
  };
  const ok = (result: unknown) => Response.json({ ok: true, result });
  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: o.hostname ?? "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/__standin/updates" && req.method === "POST") {
        const list = (await req.json().catch(() => [])) as unknown;
        const ids = (Array.isArray(list) ? list : [list]).filter((u) => u && typeof u === "object").map((u) => pushUpdate(u as Record<string, unknown>));
        return Response.json({ ok: true, ids });
      }
      if (path === "/__standin/calls" && req.method === "GET") return Response.json({ ok: true, calls, polls, pending: updates.length });
      const m = PATH.exec(path);
      if (!m || req.method !== "POST") return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      const [, token, method] = m as unknown as [string, string, string];
      const body = await readBody(req);
      if (method === "getMe") return ok(STANDIN_BOT);
      if (method === "getWebhookInfo") return ok({ url: "", pending_update_count: updates.length });
      if (method === "getUpdates") {
        polls++;
        const offset = body.offset ?? 0;
        updates = updates.filter((u) => (u.update_id as number) >= offset);
        const waitMs = Math.min(Math.max(body.timeout ?? 0, 0), 2) * 1000;
        const until = Date.now() + waitMs;
        while (updates.length === 0 && Date.now() < until) await Bun.sleep(25);
        return ok(updates.slice(0, 100));
      }
      const reply = (SEND_METHODS.has(method) ? queue.shift() : undefined) ?? { status: 200 };
      const call: StandinCall = {
        method, at: Date.now(), tokenLength: token.length, chatId: body.chatId, text: body.text,
        ...(body.photo !== undefined ? { photo: body.photo } : {}), status: reply.status,
        ...(body.replyMarkup !== undefined ? { replyMarkup: body.replyMarkup } : {}),
        ...(body.messageId !== undefined ? { messageId: body.messageId } : {}),
        ...(body.callbackQueryId !== undefined ? { callbackQueryId: body.callbackQueryId } : {}),
        ...(body.showAlert !== undefined ? { showAlert: body.showAlert } : {}),
      };
      calls.push(call);
      o.onCall?.(call);
      if (!RECORDED.has(method)) return Response.json({ ok: false, error_code: 404, description: "Not Found: method not in the stand-in" }, { status: 404 });
      if (method === "answerCallbackQuery") return ok(true);
      if (method === "editMessageText") return ok({ message_id: body.messageId ?? 0, chat: { id: Number(body.chatId) || 0 }, date: Math.floor(call.at / 1000), text: body.text });
      if (reply.status === 200) {
        const media = method === "sendPhoto" ? { photo: [{ file_id: `standin-photo-${messageId + 1}`, width: 1080, height: 1080 }] } : method === "sendVideo" ? { video: { file_id: `standin-video-${messageId + 1}` } } : {};
        return ok({ message_id: ++messageId, chat: { id: Number(body.chatId) || 0 }, date: Math.floor(call.at / 1000), ...(method === "sendMessage" ? { text: body.text } : { caption: body.text, ...media }) });
      }
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
    pushUpdate,
    polls: () => polls,
    reset: () => {
      calls.length = 0;
      queue = [];
      updates = [];
      polls = 0;
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
