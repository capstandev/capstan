// R6 kill propagation under 1 s across two Redis clients; R7 kill auth and replay; R8 kill response content.
// Needs REDIS_URL (R6, R7 idempotence) and DATABASE_URL (R8); each part skips without its service.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildRevocation as asterRevocation } from "@capstan/adapter-aster";
import { buildRevocation as hlRevocation, capstanAgentName, DEFAULT_SIGNATURE_CHAIN_ID } from "@capstan/adapter-hyperliquid";
import { capstanMessage, createRedis, schema, type Db, type Redis } from "@capstan/core";
import type { BuildContext, Hex, OnboardingBundle, UnsignedVenuePayload, VenueId, VenueIdentity } from "@capstan/schema";
import { AsterNonce } from "@capstan/signer-aster";
import { assertNoMoneyMovement, buildKillResponse, KILL_NOTE, redisKillSwitch, verifyKillAuth, type KillAdapter } from "../src";
import { testWallet } from "./accounts";
import { HOOK_MS, PG, REDIS, tempDb } from "./db";

const owner = testWallet("kill owner");
const agent = testWallet("kill agent");
const stranger = testWallet("kill stranger");
const HOST = "api.capstan.test";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

async function killMsg(signer: typeof owner, o: Partial<{ ref: string; issuedAt: number; purpose: "kill" | "read"; nonce: string; owner: Hex }> = {}) {
  const issuedAt = o.issuedAt ?? NOW - 1000;
  const message = capstanMessage({ purpose: o.purpose ?? "kill", owner: o.owner ?? owner.address, host: HOST, chainId: 4663, nonce: o.nonce ?? `kill-${Math.random().toString(36).slice(2, 12)}`, issuedAt, expiresAt: issuedAt + 5 * 60_000, body: o.ref ?? "agent-1" });
  return { message, sig: await signer.signMessage({ message }) };
}

const rd = REDIS ? describe : describe.skip;
rd("kill switch on Redis", () => {
  let a: Redis;
  let b: Redis;
  beforeAll(() => {
    a = createRedis(REDIS!);
    b = createRedis(REDIS!);
  });
  afterAll(async () => {
    await a.quit();
    await b.quit();
  });

  test("under-1s", async () => {
    const ka = redisKillSwitch(a, null);
    const kb = redisKillSwitch(b, null);
    const heard: Map<string, number> = new Map();
    const waiters = new Map<string, () => void>();
    const unsub = kb.subscribe((ref) => {
      heard.set(ref, performance.now());
      waiters.get(ref)?.();
    });
    await new Promise((r) => setTimeout(r, 100)); // let SUBSCRIBE land
    const lookups: number[] = [];
    const pushes: number[] = [];
    const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 50; i++) {
      const ref = `under1s-${run}-${i}`;
      expect(await kb.isKilled(ref)).toBe(false);
      const pushed = new Promise<void>((res) => waiters.set(ref, res));
      const t0 = performance.now();
      await ka.kill(ref, "owner");
      // a second process's lookup sees the flag
      while (!(await kb.isKilled(ref))) if (performance.now() - t0 > 2000) throw new Error("not propagated");
      lookups.push(performance.now() - t0);
      await Promise.race([pushed, new Promise((_, rej) => setTimeout(() => rej(new Error("no pub/sub push")), 2000))]);
      pushes.push(heard.get(ref)! - t0);
    }
    unsub();
    await kb.close?.();
    const p99 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.ceil(xs.length * 0.99) - 1]!;
    expect(lookups.length).toBe(50);
    expect(p99(lookups)).toBeLessThan(1000);
    expect(p99(pushes)).toBeLessThan(1000);
    // the flag has no expiry
    expect(await a.pttl(`kill:under1s-${run}-0`)).toBe(-1);
  }, 60_000);

  test("auth-and-replay", async () => {
    const dg = { owner: owner.address, agentAddress: agent.address };
    const at = { host: HOST, nowMs: NOW, chainId: 4663 };
    // the owner's signature and the agent's own signature (self-halt) both work
    let m = await killMsg(owner);
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, at)).toBe("owner");
    m = await killMsg(agent);
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, at)).toBe("agent");
    // any other signer is refused
    m = await killMsg(stranger);
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, at)).toBeNull();
    // the agent's key cannot kill an agent of a delegation that names another address
    m = await killMsg(agent);
    expect(verifyKillAuth("agent-1", m.message, m.sig, { owner: owner.address, agentAddress: stranger.address }, at)).toBeNull();
    // a ts older than 5 minutes is refused (issued 5 min + 1 ms ago, and also an already expired message)
    m = await killMsg(owner, { issuedAt: NOW - 5 * 60_000 - 1 });
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, at)).toBeNull();
    // SIG-1: another purpose, another agent ref in the body, another owner line or host never kill
    m = await killMsg(owner, { purpose: "read" });
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, at)).toBeNull();
    m = await killMsg(owner, { ref: "agent-2" });
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, at)).toBeNull();
    m = await killMsg(stranger, { owner: stranger.address });
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, at)).toBeNull();
    m = await killMsg(owner);
    expect(verifyKillAuth("agent-1", m.message, m.sig, dg, { ...at, host: "evil.test" })).toBeNull();
    expect(verifyKillAuth("agent-1", m.message.replace("Capstan kill", "Capstan  kill"), m.sig, dg, at)).toBeNull();

    // a replayed kill is harmless: the flag stays set, nothing toggles back
    const ks = redisKillSwitch(a, null);
    const ref = `replay-${Date.now().toString(36)}`;
    expect(await ks.kill(ref, "owner")).toEqual({ alreadyKilled: false });
    expect(await ks.kill(ref, "agent")).toEqual({ alreadyKilled: true });
    expect(await ks.isKilled(ref)).toBe(true);
    expect(await a.get(`kill:${ref}`)).toBe("owner"); // the first killer is kept
  });

  test("Redis unreachable: lookups fail closed", async () => {
    const dead = createRedis("redis://127.0.0.1:1", { lazyConnect: true });
    dead.on("error", () => undefined);
    const ks = redisKillSwitch(dead, null);
    expect(await ks.isKilled("anything")).toBe(true);
    dead.disconnect();
  });
});

const pg = PG ? describe : describe.skip;
pg("kill response", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  let db: Db;
  beforeAll(async () => {
    t = await tempDb("capstan_kill");
    db = t.db;
    await db.insert(schema.delegations).values([
      { id: "hl-1", venue: "hyperliquid", owner: owner.address, agentAddress: agent.address, state: "active" },
      { id: "aster-1", venue: "aster", owner: owner.address, agentAddress: agent.address, state: "active" },
      { id: "lt-1", venue: "lighter-mainnet", owner: owner.address, accountIndex: 7, apiKeyIndex: 4, state: "active" },
      { id: "other-owner", venue: "aster", owner: stranger.address, agentAddress: stranger.address, state: "active" },
    ]);
  }, HOOK_MS);
  afterAll(async () => t?.drop(), HOOK_MS);

  const closeBuild = (id: VenueIdentity, reduceOnly = true): UnsignedVenuePayload => ({
    buildId: "01JCLOSE00000000000000000",
    venue: id.venue,
    signer: "delegated_key",
    encoding: "hl_l1_action",
    payload: { type: "order", orders: [{ a: 1, b: false, r: reduceOnly }] },
    digest: "0x00",
    preview: { marketId: "hyperliquid:-:ETH", side: "sell", size: "1", px: "1900", notionalUsd: "1900", venueFeeBps: 4.5, builderFeeBps: 0, builderFee: null, slippageBps: 50, estLiqPx: null, collateralAsset: "USDC", reduceOnly, warnings: [] },
    expiresAt: NOW + 30_000,
    eligibilityDecisionId: "not-required:kill",
  });
  const caps = (venue: VenueId) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true });
  const hl: KillAdapter = {
    caps: caps("hyperliquid"),
    buildRevocation: (id) => hlRevocation({ ...id, agentName: capstanAgentName(id.agentAddress!) }, { network: "Testnet", signatureChainId: DEFAULT_SIGNATURE_CHAIN_ID, nowMs: NOW, throwawayAgent: testWallet("throwaway").address, builder: stranger.address, builderRevokeConfirmed: false }),
    buildCloseAll: async (id, _ctx: BuildContext) => [closeBuild(id)],
  };
  const aster: KillAdapter = {
    caps: caps("aster"),
    buildRevocation: async (id) => asterRevocation(id.owner, id.agentAddress!, { builder: stranger.address, nonce: new AsterNonce(), network: "Testnet", nowMs: NOW }),
    buildCloseAll: async (id) => [closeBuild(id)],
  };

  test("revocation-content", async () => {
    const r = await buildKillResponse("hl-1", { adapters: new Map([["hyperliquid", hl], ["aster", aster]]), db, closeAll: true, now: () => NOW });
    expect(r.relayBlocked).toBe(true);
    expect(r.note).toBe(KILL_NOTE);
    expect(r.note).toContain("only your wallet can do that");
    // one bundle per venue this key was onboarded on (HL and Aster; the Lighter key of the owner is another agent)
    expect(r.revocations.map((b) => b.venue).sort()).toEqual(["aster", "hyperliquid"]);
    expect(r.revocation?.venue).toBe("hyperliquid");
    const kinds = r.revocations.flatMap((b) => b.steps.map((s) => `${b.venue}:${s.kind}`)).sort();
    expect(kinds).toEqual(["aster:revoke_agent", "aster:revoke_builder", "hyperliquid:revoke_agent"]);
    for (const b of r.revocations) for (const s of b.steps) expect(s.signer === "main_wallet" || s.kind === "revoke_builder").toBe(true);
    // close-all payloads are reduce-only, one per venue here
    expect(r.closeAll?.length).toBe(2);
    expect(r.closeAll!.every((p) => p.preview.reduceOnly)).toBe(true);
    // never a transfer or withdrawal anywhere in the response
    expect(JSON.stringify(r)).not.toMatch(/withdraw|usdSend|spotSend|sendAsset|usdClassTransfer|vaultTransfer/i);
    // without closeAll: no close payloads
    const r2 = await buildKillResponse("hl-1", { adapters: new Map([["hyperliquid", hl], ["aster", aster]]), db, closeAll: false, now: () => NOW });
    expect(r2.closeAll).toBeUndefined();
    // a venue with no adapter on this host is reported, never silently dropped
    const r3 = await buildKillResponse("hl-1", { adapters: new Map([["hyperliquid", hl]]), db, closeAll: false, now: () => NOW });
    expect(r3.unavailable.map((u) => u.venue)).toEqual(["aster"]);
  });

  test("a builder that slips in a transfer or a non reduce-only close is refused", async () => {
    const bad: OnboardingBundle = { bundleId: "b", venue: "hyperliquid", owner: owner.address, steps: [{ kind: "revoke_agent", signer: "main_wallet", typedData: { domain: {}, types: {}, primaryType: "HyperliquidTransaction:UsdSend", message: {} } }], humanReadable: [], templateHash: "0x00", expiresAt: 0 };
    expect(() => assertNoMoneyMovement(bad)).toThrow("fund movement");
    expect(() => assertNoMoneyMovement({ ...bad, steps: [{ kind: "hl_collateral_move", signer: "main_wallet" }] })).toThrow("not a revocation");
    expect(() => assertNoMoneyMovement(closeBuild({ venue: "hyperliquid", owner: owner.address }, false))).toThrow("reduce-only");
    const sneaky: KillAdapter = { ...hl, buildRevocation: async () => bad };
    await expect(buildKillResponse("hl-1", { adapters: new Map([["hyperliquid", sneaky]]), db, closeAll: false })).rejects.toThrow("fund movement");
    const openClose: KillAdapter = { ...hl, buildCloseAll: async (id) => [closeBuild(id, false)] };
    await expect(buildKillResponse("hl-1", { adapters: new Map([["hyperliquid", openClose]]), db, closeAll: true })).rejects.toThrow("reduce-only");
  });
});
