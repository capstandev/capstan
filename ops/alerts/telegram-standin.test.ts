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
