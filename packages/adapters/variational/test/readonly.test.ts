// R8: every execution method on the data-only adapter throws VENUE_DATA_ONLY and caps.execution is false.
import { describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { createVariationalAdapter } from "../src/adapter";
import { EXECUTION_METHODS } from "../src/readonly";

describe("readonly", () => {
  test("no-execution", async () => {
    const http = venueHttp("variational", "http://variational.invalid", createMemoryGovernor("ro"), { fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    const a = createVariationalAdapter(http, null) as unknown as Record<string, (...x: unknown[]) => unknown> & { caps: Record<string, unknown> };
    expect(a.caps).toMatchObject({ venue: "variational", execution: false, keyType: null, delegation: "none", canWithdraw: false, builderFee: null, directSubmitSupported: false, publicAccountReads: false });
    expect(EXECUTION_METHODS.length).toBe(11);
    for (const m of EXECUTION_METHODS) {
      expect(typeof a[m]).toBe("function");
      let err: unknown = null;
      try {
        await a[m]!({});
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CapstanError);
      expect((err as CapstanError).code).toBe("VENUE_DATA_ONLY");
    }
  });
});
