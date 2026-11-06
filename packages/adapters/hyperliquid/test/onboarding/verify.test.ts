// R10: delegation state read back from the venue.
import { describe, expect, test } from "bun:test";
import { capstanAgentName, verifyOnboarding } from "../../src";
import { BUILDER } from "../helpers";
import { AGENT, context, DAY, NOW, OWNER } from "./util";

describe("verify", () => {
  test("delegation-state", async () => {
    const id = { venue: "hyperliquid" as const, owner: OWNER, agentAddress: AGENT };
    const ours = { name: capstanAgentName(AGENT), address: AGENT, validUntil: NOW + 30 * DAY };
    const run = async (agents: unknown[], mbf: number, now = NOW) => {
      const { reader } = context((b) => (b.type === "extraAgents" ? agents : b.type === "maxBuilderFee" ? mbf : undefined));
      return verifyOnboarding(reader, id, BUILDER, now);
    };
    const ok = await run([ours], 30);
    expect(ok).toEqual({ agentActive: true, builderMaxBps: 3, expiresAt: new Date(NOW + 30 * DAY).toISOString(), routing: "ok" });
    expect((await run([ours], 20)).routing).toBe("ok");
    expect((await run([ours], 19)).routing).toBe("fee_free_unavailable");
    expect((await run([ours], 0)).routing).toBe("fee_free_unavailable");
    expect((await run([ours], 0)).builderMaxBps).toBe(0);
    // expired, other name, other address, absent
    expect((await run([ours], 30, NOW + 31 * DAY)).agentActive).toBe(false);
    expect((await run([{ ...ours, name: "someone-else" }], 30)).agentActive).toBe(false);
    expect((await run([{ ...ours, address: "0x1111111111111111111111111111111111111111" }], 30)).agentActive).toBe(false);
    expect((await run([], 30)).agentActive).toBe(false);
  });
});
