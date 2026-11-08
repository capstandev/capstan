// R2-SPREADS-01: the per-kind event data allow-list read allowed[k] on a plain object literal, so inherited
// Object.prototype names resolved: "constructor" and "toString" accepted any nested JSON, and "__proto__", "valueOf"
// or "hasOwnProperty" threw a TypeError (a 500). Only the kind's own field names are accepted now.
import { describe, expect, test } from "bun:test";
import { recordEvent, type EventDeps } from "../../src";

const deps = { store: { get: async () => null } } as unknown as EventDeps;

describe("event data allow-list ignores inherited keys (R2-SPREADS-01)", () => {
  for (const key of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    test(`data.${key} is refused as INVALID_INPUT before any store read`, async () => {
      const data = JSON.parse(`{"${key}": {"nested": [1, 2, 3]}}`) as Record<string, unknown>;
      const e = await recordEvent("plan-1", { kind: "leg_a_sent", data } as never, deps).catch((x: unknown) => x);
      expect((e as { code?: string }).code).toBe("INVALID_INPUT");
      expect(String((e as Error).message)).toContain(`data.${key} is not accepted`);
    });
  }
});
