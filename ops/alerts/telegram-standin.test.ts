// The stand-in's --script parser and its sendPhoto recording (the release announcer's shell proof relies on both).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseScript, startTelegramStandin, type TelegramStandin } from "./telegram-standin";

describe("parseScript", () => {
  test("statuses in order, 429 with retry_after", () => {
    expect(parseScript("429:1,500, 200")).toEqual([{ status: 429, retryAfter: 1 }, { status: 500 }, { status: 200 }]);
  });
  test("empty means no script", () => {
    expect(parseScript("")).toEqual([]);
  });
  test("refuses anything that is not a status", () => {
    expect(() => parseScript("429:x")).toThrow();
    expect(() => parseScript("ok")).toThrow();
    expect(() => parseScript("99")).toThrow();
  });
});

describe("sendPhoto through the stand-in", () => {
  let s: TelegramStandin;
  beforeAll(() => {
    s = startTelegramStandin({ port: 0 });
  });
  afterAll(() => s.stop());

  test("records the caption and the photo size; a scripted 429 carries retry_after", async () => {
    s.script(...parseScript("429:2"));
    const send = () => {
      const f = new FormData();
      f.set("chat_id", "-100123");
      f.set("caption", "Update 7 is live");
      f.set("photo", new Blob([new Uint8Array(321)], { type: "image/png" }), "update-07.png");
      return fetch(`${s.url}/bot1:abc/sendPhoto`, { method: "POST", body: f });
    };
    const first = await send();
    expect(first.status).toBe(429);
    expect(((await first.json()) as { parameters: { retry_after: number } }).parameters.retry_after).toBe(2);
    const second = await send();
    expect(second.status).toBe(200);
    const got = s.delivered("sendPhoto");
    expect(got.length).toBe(1);
    expect(got[0]?.text).toBe("Update 7 is live");
    expect(got[0]?.photo).toBe(321);
    expect(got[0]?.tokenLength).toBe(5);
  });
});

describe("inbound side for the team bot", () => {
  let s: TelegramStandin;
  beforeAll(() => {
    s = startTelegramStandin({ port: 0 });
  });
  afterAll(() => s.stop());
  const post = (method: string, body: unknown) =>
    fetch(`${s.url}/bot1:abc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ ok: boolean; result: unknown }>);

  test("getUpdates hands out pushed updates from the offset on; a scripted 429 is kept for the send methods", async () => {
    s.script({ status: 429, retryAfter: 1 });
    const a = s.pushUpdate({ message: { message_id: 1, text: "/status" } });
    const b = s.pushUpdate({ message: { message_id: 2, text: "/help" } });
    const all = (await post("getUpdates", { offset: 0, timeout: 0 })).result as { update_id: number }[];
    expect(all.map((u) => u.update_id)).toEqual([a, b]);
    const rest = (await post("getUpdates", { offset: b, timeout: 0 })).result as { update_id: number }[];
    expect(rest.map((u) => u.update_id)).toEqual([b]);
    expect((await post("getUpdates", { offset: b + 1, timeout: 0 })).result).toEqual([]);
    expect(s.polls()).toBe(3);
    expect((await post("sendMessage", { chat_id: 1, text: "x" })).ok).toBe(false);
  });

  test("getMe, callback answers, edits and buttons are recorded", async () => {
    s.reset();
    expect(((await post("getMe", {})).result as { is_bot: boolean }).is_bot).toBe(true);
    await post("sendMessage", { chat_id: -1, text: "Pause?", reply_markup: { inline_keyboard: [[{ text: "Confirm", callback_data: "p:1:y" }]] } });
    await post("answerCallbackQuery", { callback_query_id: "q1", text: "Only the owner can do that.", show_alert: true });
    await post("editMessageText", { chat_id: -1, message_id: 1, text: "Done." });
    const [m, q, e] = s.calls;
    expect(JSON.parse(m?.replyMarkup ?? "{}").inline_keyboard[0][0].text).toBe("Confirm");
    expect(q).toMatchObject({ method: "answerCallbackQuery", callbackQueryId: "q1", showAlert: true });
    expect(e).toMatchObject({ method: "editMessageText", messageId: 1, text: "Done." });
  });

  test("shell control endpoints", async () => {
    s.reset();
    const r = (await fetch(`${s.url}/__standin/updates`, { method: "POST", body: JSON.stringify([{ message: { text: "a" } }]) }).then((x) => x.json())) as { ids: number[] };
    expect(r.ids.length).toBe(1);
    const c = (await fetch(`${s.url}/__standin/calls`).then((x) => x.json())) as { pending: number };
    expect(c.pending).toBe(1);
  });
});
