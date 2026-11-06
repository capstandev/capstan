// Nonces are ms timestamps inside (T - 2 d, T + 1 d).
import { describe, expect, test } from "bun:test";
import { assertNonceWindow } from "../src";

const NOW = 1793900000000;
const DAY = 86_400_000;

describe("nonce", () => {
  test("window", () => {
    expect(() => assertNonceWindow(NOW, NOW)).not.toThrow();
    expect(() => assertNonceWindow(NOW - 2 * DAY + 1, NOW)).not.toThrow();
    expect(() => assertNonceWindow(NOW + DAY - 1, NOW)).not.toThrow();
    expect(() => assertNonceWindow(NOW - 2 * DAY, NOW)).toThrow(/past/);
    expect(() => assertNonceWindow(NOW + DAY, NOW)).toThrow(/future/);
    expect(() => assertNonceWindow(1.5, NOW)).toThrow();
    expect(() => assertNonceWindow(0, NOW)).toThrow();
  });
});
