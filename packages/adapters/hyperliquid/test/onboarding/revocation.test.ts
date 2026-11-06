// R11: revocation = ApproveAgent with the same name, a fresh throwaway address and valid_until now + 1 minute.
import { describe, expect, test } from "bun:test";
import { parseAgentName } from "@capstan/signer-hl";
import { buildRevocation, capstanAgentName } from "../../src";
import { BUILDER } from "../helpers";
import { AGENT, NOW, OWNER } from "./util";

const THROWAWAY = "0x2222222222222222222222222222222222222222" as const;

describe("revocation", () => {
  test("same-name-new-address", async () => {
    const name = capstanAgentName(AGENT);
    const id = { venue: "hyperliquid" as const, owner: OWNER, agentAddress: AGENT, agentName: `${name} valid_until ${NOW + 1000000}` };
    const b = await buildRevocation(id, { network: "Mainnet", signatureChainId: "0xa4b1", nowMs: NOW, throwawayAgent: THROWAWAY, builder: BUILDER, builderRevokeConfirmed: false });
    expect(b.steps.length).toBe(1);
    const s = b.steps[0]!;
    expect(s.kind).toBe("revoke_agent");
    expect(s.signer).toBe("main_wallet");
    expect(s.typedData!.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    expect(s.typedData!.message.agentAddress).toBe(THROWAWAY);
    const parsed = parseAgentName(s.typedData!.message.agentName as string);
    expect(parsed.name).toBe(name);
    expect(parsed.validUntil).toBe(NOW + 60_000);
    // the flag off by default: no builder revoke
    const def = await buildRevocation(id, { network: "Mainnet", signatureChainId: "0xa4b1", nowMs: NOW, throwawayAgent: THROWAWAY, builder: BUILDER });
    expect(def.steps.map((x) => x.kind)).toEqual(["revoke_agent"]);
    // behind the flag: builder "0%"
    const on = await buildRevocation(id, { network: "Mainnet", signatureChainId: "0xa4b1", nowMs: NOW, throwawayAgent: THROWAWAY, builder: BUILDER, builderRevokeConfirmed: true });
    expect(on.steps.map((x) => x.kind)).toEqual(["revoke_agent", "revoke_builder"]);
    expect(on.steps[1]!.typedData!.message.maxFeeRate).toBe("0%");
    // refusals: zero address, the same agent, the owner, an unnamed agent
    const ctx = { network: "Mainnet" as const, signatureChainId: "0xa4b1" as const, nowMs: NOW };
    await expect(buildRevocation(id, { ...ctx, throwawayAgent: "0x0000000000000000000000000000000000000000" })).rejects.toThrow(/non-zero/);
    await expect(buildRevocation(id, { ...ctx, throwawayAgent: AGENT })).rejects.toThrow(/differ/);
    await expect(buildRevocation(id, { ...ctx, throwawayAgent: OWNER })).rejects.toThrow(/owner/);
    await expect(buildRevocation({ ...id, agentName: "" }, { ...ctx, throwawayAgent: THROWAWAY })).rejects.toThrow(/named agent/);
  });
});
