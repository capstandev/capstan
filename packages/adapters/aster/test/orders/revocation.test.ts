// R11 (todo 15): revocation submit sends DelAgent then DelBuilder and reports each result.
import { accountSigner, digestTypedData } from "@capstan/signer-aster";
import { describe, expect, test } from "bun:test";
import { json } from "../helpers";
import { agent, owner, setup } from "./setup";

describe("aster revocation submit", () => {
  test("submit-both", async () => {
    const order: string[] = [];
    const s = setup({
      "/fapi/v3/agent": (r) => {
        order.push(`${r.method} agent`);
        return json({ code: 200, msg: "success" });
      },
      "/fapi/v3/builder": (r) => {
        order.push(`${r.method} builder`);
        return json({ code: -1000, msg: "builder not found" }, 400);
      },
    });
    try {
      const b = await s.adapter.buildRevocation({ venue: "aster", owner: owner.address, agentAddress: agent.address });
      const sign = accountSigner(owner);
      const sigs = await Promise.all(b.steps.map(async (st, i) => ({ step: i, sig: await sign(digestTypedData(st.typedData!)) })));
      const r = await s.adapter.submitRevocation({ bundleId: b.bundleId, signatures: sigs }, b);
      expect(order).toEqual(["DELETE agent", "DELETE builder"]);
      expect(r.steps.map((x) => [x.kind, x.status])).toEqual([["revoke_agent", "accepted"], ["revoke_builder", "rejected"]]);
      expect(r.delegation.agentActive).toBe(false);
      // only the owner's signatures are forwarded
      const bad = await Promise.all(b.steps.map(async (st, i) => ({ step: i, sig: await accountSigner(agent)(digestTypedData(st.typedData!)) })));
      expect(await s.adapter.submitRevocation({ bundleId: b.bundleId, signatures: bad }, b).catch((e: { code: string }) => e.code)).toBe("UNAUTHORIZED");
      expect(order.length).toBe(2);
    } finally {
      s.stop();
    }
  });
});
