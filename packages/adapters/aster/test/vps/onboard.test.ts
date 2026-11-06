// R15 (todo 14), VPS only (BACKLOG A4): the testnet server accepts approveAgent and approveBuilder built here, the
// agent shows canWithdraw false and canSpotTrade false, and both IP delimiters are probed and recorded.
import type { Hex } from "@capstan/schema";
import { AsterNonce, digestTrade, digestTypedData } from "@capstan/signer-aster";
import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountSigner } from "@capstan/signer-aster";
import { buildOnboarding, mgmtStep, submitOnboarding, updateAgentTx } from "../../src/onboarding";
import { buildRevocation } from "../../src/revocation";
import { castAddress, castSigner, record, serverTimeMs, signedGet, SKIP_REASON, testnetOnly, VPS } from "./helpers";

const vps = VPS ? test : test.skip;
const BUILDER = (process.env.ASTER_TESTNET_BUILDER ?? "") as Hex;

describe(`aster testnet onboarding (${VPS ? "running" : SKIP_REASON})`, () => {
  vps(
    "server-accepts",
    async () => {
      const { http } = testnetOnly();
      expect(/^0x[0-9a-fA-F]{40}$/.test(BUILDER)).toBe(true);
      const owner = castAddress();
      const agent = privateKeyToAccount(generatePrivateKey()); // throwaway testnet agent, memory only
      const nonce = new AsterNonce();
      const now = await serverTimeMs(http);
      const eligibilityStep = { kind: "eligibility_declaration" as const, signer: "main_wallet" as const, personalSignText: "testnet run" };
      const b = buildOnboarding({ owner, agentAddress: agent.address, mode: "direct", network: "Testnet", nowMs: now }, { relayEgressIp: "", builder: BUILDER, nonce, serverTimeMs: now, eligibilityStep });
      const sigs = [];
      for (let i = 0; i < b.steps.length; i++) if (b.steps[i]!.venueTx) sigs.push({ step: i, sig: await castSigner(digestTypedData(b.steps[i]!.typedData!)) });
      const res = await submitOnboarding({ bundleId: b.bundleId, signatures: sigs }, http, b, Date.now());
      await record("onboard-submit", res.venueResponses);
      expect(res.steps.map((s) => s.status)).toEqual(["accepted", "accepted"]);
      const agentNonce = new AsterNonce();
      const view = await signedGet(http, "/fapi/v3/agent", [["asterChain", "Testnet"], ["user", owner], ["signer", agent.address], ["nonce", agentNonce.next(BigInt(Date.now()) * 1000n)]], accountSigner(agent), (qs) => digestTrade(qs, 714));
      await record("agent-view", view);
      const rows = (Array.isArray(view.body) ? view.body : [view.body]) as { agentAddress?: string; canWithdraw?: boolean; canSpotTrade?: boolean }[];
      const mine = rows.find((r) => r.agentAddress?.toLowerCase() === agent.address.toLowerCase())!;
      expect(mine.canWithdraw).toBe(false);
      expect(mine.canSpotTrade).toBe(false);
      // IP delimiter probe: comma, then space (recorded either way), then back to none
      for (const list of ["198.51.100.1,198.51.100.2", "198.51.100.1 198.51.100.2", ""]) {
        const t = Date.now();
        const tx = updateAgentTx({ agentAddress: agent.address, ipWhitelist: list, expired: t + 86_400_000, network: "Testnet", owner, nonce: Number(nonce.next(BigInt(t) * 1000n)) });
        const step = mgmtStep("aster_approve_agent", tx);
        const pb = { ...b, bundleId: `${b.bundleId}-ip`, steps: [step], expiresAt: t + 50_000 };
        const r = await submitOnboarding({ bundleId: pb.bundleId, signatures: [{ step: 0, sig: await castSigner(digestTypedData(step.typedData!)) }] }, http, pb, Date.now());
        await record(`ip-delimiter-${list.includes(",") ? "comma" : list ? "space" : "empty"}`, r.venueResponses);
      }
      // clean up: remove the throwaway agent (the builder approval stays for the order test)
      const rv = buildRevocation(owner, agent.address, { builder: BUILDER, nonce, network: "Testnet", nowMs: Date.now() });
      const del = { ...rv, steps: [rv.steps[0]!] };
      const dr = await submitOnboarding({ bundleId: del.bundleId, signatures: [{ step: 0, sig: await castSigner(digestTypedData(del.steps[0]!.typedData!)) }] }, http, del, Date.now());
      await record("del-agent", dr.venueResponses);
    },
    120_000,
  );
});
