// lighter-rh-health job: definition, a passing check logs, a moved pin publishes an ops alert.
import { afterAll, describe, expect, test } from "bun:test";
import { logger, type JobDeps } from "@capstan/core";
import { LIGHTER_CONFIGS, LIGHTER_RH_DEPOSIT, lighterReaderFor } from "@capstan/adapter-lighter";
import type { Hex } from "@capstan/schema";
import { createMemoryGovernor, fakeVenueServer } from "@capstan/venue-client";
import { job, OPS_ALERT_CHANNEL, runRhHealth } from "../src/jobs/lighter-rh-health.job";

const srv = fakeVenueServer({ "GET /info": () => new Response(JSON.stringify({ contract_address: LIGHTER_RH_DEPOSIT.address }), { headers: { "content-type": "application/json" } }) });
afterAll(() => srv.stop());
const slot = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;

describe("lighter-rh-health job", () => {
  test("definition, ok, and alert on a moved implementation", async () => {
    expect(job).toMatchObject({ name: "lighter-rh-health", queue: "reconcileDaily", schedule: { pattern: "45 0 * * *" }, concurrency: 1 });
    const published: { ch: string; payload: unknown }[] = [];
    const deps: JobDeps = { db: null, redis: null, cache: null, log: logger("t", { sink: () => {} }), now: () => new Date(), publish: async (ch, payload) => void published.push({ ch, payload }) };
    const reader = lighterReaderFor(LIGHTER_CONFIGS.rh, createMemoryGovernor("t"), null, { rest: srv.url });
    expect((await runRhHealth(deps, { reader, rpc: { getStorageAt: async () => slot(LIGHTER_RH_DEPOSIT.implementationAtPin) } })).ok).toBe(true);
    expect(published).toEqual([]);
    const r = await runRhHealth(deps, { reader, rpc: { getStorageAt: async () => slot("0x3333333333333333333333333333333333333333") } });
    expect(r.ok).toBe(false);
    expect(published).toEqual([{ ch: OPS_ALERT_CHANNEL, payload: { kind: "lighter_rh.deposit_pin_mismatch", detail: { reason: expect.stringContaining("implementation"), contract: LIGHTER_RH_DEPOSIT.address, implementation: "0x3333333333333333333333333333333333333333" } } }]);
  });
});
