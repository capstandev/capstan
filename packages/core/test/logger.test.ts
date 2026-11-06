import { describe, expect, test } from "bun:test";
import { logger, REDACTED } from "../src/logger";

describe("logger", () => {
  test("redaction", () => {
    const lines: string[] = [];
    const log = logger("svc", { sink: (l) => lines.push(l), level: "debug" });
    const hex64 = "ab".repeat(32);
    const sig65 = `0x${"cd".repeat(65)}`;
    log.info(`tx 0x${hex64} done`, {
      signature: sig65,
      sig: "x",
      password: "pw",
      token: "t",
      apiKey: "k",
      keyHash: "h",
      nested: { authorization: "Bearer abc", txHash: `0x${hex64}`, list: [hex64] },
      amount: "1.5",
    });
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.service).toBe("svc");
    expect(rec.level).toBe("info");
    for (const k of ["signature", "sig", "password", "token", "apiKey", "keyHash"]) expect(rec[k]).toBe(REDACTED);
    expect(rec.nested.authorization).toBe(REDACTED);
    expect(rec.amount).toBe("1.5");
    expect(rec.nested.txHash).toMatch(/^0xabab\.\.abab$/);
    expect(lines[0]).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(lines[0]).not.toContain("Bearer abc");
  });

  test("levels and child fields", () => {
    const lines: string[] = [];
    const log = logger("svc", { sink: (l) => lines.push(l), level: "warn" });
    log.info("hidden");
    log.child({ job: "j" }).warn("shown", { n: 1 });
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "shown", job: "j", n: 1 });
  });
});
