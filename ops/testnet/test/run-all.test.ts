// run-all.ts (todo 41 R10 and the skip rule), doctor.ts and faucet.ts with stand-ins: no network, no real wallets.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDoctor, type Readers } from "../doctor";
import { solanaAirdrop } from "../faucet";
import { runAll, testCounts } from "../run-all";
import { recordAddress, paths } from "../wallets";
import { fakeDoctor, jsonRpcFetch, tempHome } from "./helpers";

describe("run-all", () => {
  test("skips-unfunded: nothing runs without funded wallets, and each row names its BACKLOG item", async () => {
    const { dir, env } = tempHome();
    const calls: string[][] = [];
    const res = await runAll({ env, exec: async (c) => (calls.push(c), { code: 0, out: "" }), doctor: async () => fakeDoctor([]), canaries: false, reportDir: dir, airdrop: async (a) => ({ address: a, sol: 1, signature: null, error: "HTTP 429" }) });
    expect(calls).toEqual([]);
    const by = Object.fromEntries(res.rows.map((r) => [r.suite, r]));
    expect(by["rhc: Safe + deploy + Sourcify + PostDeployCheck"]).toMatchObject({ result: "waiting", detail: expect.stringContaining("A1") });
    expect(by["hyperliquid testnet: onboard, order, HIP-3"]).toMatchObject({ result: "waiting", detail: expect.stringContaining("A2") });
    expect(by["lighter testnet (signing id 300)"]).toMatchObject({ result: "waiting", detail: expect.stringContaining("A3") });
    expect(by["x402: Base Sepolia USDC + RHC testnet USDG"]).toMatchObject({ result: "waiting", detail: expect.stringMatching(/A5.*A6|A6.*A5/) });
    expect(by["aster testnet (VPS)"]).toMatchObject({ result: "skip", detail: expect.stringContaining("VPS only") });
    expect(by["faucet: Solana devnet airdrop"]).toMatchObject({ result: "waiting", detail: expect.stringContaining("429") });
    expect(res.rows.some((r) => r.result === "fail")).toBe(false);
  });

  test("second-run-skips-deployed: the second run skips deployed contracts and reuses the wallets (R10)", async () => {
    const { dir, env } = tempHome();
    const home = env.CAPSTAN_TESTNET_HOME!;
    mkdirSync(home, { recursive: true });
    let deploys = 0;
    let safes = 0;
    const seenEnv: Record<string, string>[] = [];
    const exec = async (cmd: string[], e: Record<string, string>) => {
      if (cmd.includes("ops/testnet/make-safe.sh")) {
        safes++;
        writeFileSync(join(home, "brand-safe.json"), JSON.stringify({ address: "0x00000000000000000000000000000000000000b5" }));
        return { code: 0, out: safes === 1 ? "safe: chain id 46630 ok\nsafe: brand Safe 0x00000000000000000000000000000000000000b5 created" : "safe: chain id 46630 ok\nskip: brand Safe already at 0x00000000000000000000000000000000000000b5" };
      }
      if (cmd.includes("ops/deploy/deploy-rhc.sh")) {
        deploys++;
        seenEnv.push(e);
        return deploys === 1
          ? { code: 0, out: "stage 1: chain id 46630 ok\nstage 4: deployed (log: x)\nstage 5: Sourcify recorded as verified, copies regenerated\nstage 6: post-deploy check ok (3 contracts)" }
          : { code: 0, out: "stage 1: chain id 46630 ok\nskip: already deployed at 0x1 (CPST)\nskip: already deployed at 0x2 (CPSTLock)\nskip: already deployed at 0x3 (CapstanReceiptAnchor)\nskip: stage 4, nothing to deploy\nskip: stage 5, Sourcify already recorded\nstage 6: post-deploy check ok (3 contracts)" };
      }
      return { code: 0, out: " 1 pass\n 0 fail\n" };
    };
    const addresses: Record<string, string> = {};
    const doctor = async () => fakeDoctor(["deployer", "anchor-poster", "sol-facilitator"], addresses);
    const one = await runAll({ env, exec, doctor, canaries: false, reportDir: dir });
    const two = await runAll({ env, exec, doctor, canaries: false, reportDir: dir });
    expect([one.run, two.run]).toEqual([1, 2]);
    const dep = (r: typeof one) => r.rows.find((x) => x.suite === "rhc: deploy (deploy-rhc.sh testnet)")!;
    expect(dep(one)).toMatchObject({ result: "pass", detail: "stage 4: deployed (log: x)" });
    expect(dep(two)).toMatchObject({ result: "pass", detail: "skipped: all three contracts already deployed (deployment file + code check)" });
    expect(two.rows.find((x) => x.suite === "rhc: testnet brand Safe")!.detail).toContain("skip: brand Safe already");
    expect(seenEnv[0]).toEqual(seenEnv[1]!); // same keystore, password file path, poster and Safe both times
    expect(seenEnv[0]).toMatchObject({ BRAND_SAFE: "0x00000000000000000000000000000000000000b5", POSTER_ADDRESS: addresses["anchor-poster"], DEPLOYER_PASSWORD_FILE: join(home, "capstan-testnet-deployer.password") });
    const text = readFileSync(one.report, "utf8");
    expect(text.match(/^## Run \d+/gm)).toEqual(["## Run 1", "## Run 2"]);
    expect(text).toContain("## Faucets checked");
  });

  test("bun test summary counts", () => {
    expect(testCounts(" 3 pass\n 1 skip\n 0 fail\n")).toEqual({ pass: 3, fail: 0, skip: 1 });
  });
});

describe("doctor", () => {
  test("one row per need, funded only when every need is met, never reading a keystore", async () => {
    const { env } = tempHome();
    const p = paths(env);
    mkdirSync(p.home, { recursive: true });
    await recordAddress(p, "deployer", "0x00000000000000000000000000000000000000d1");
    await recordAddress(p, "facilitator", "0x00000000000000000000000000000000000000f1");
    const readers: Readers = {
      evmNative: async (_rpc, chainId) => (chainId === 46630 ? 0.01 : 0),
      erc20: async () => 0,
      hlPerps: async () => ({ perps: 0, spotUsdc: 0 }),
      lighter: async () => ({ index: null, collateral: 0 }),
      solNative: async () => 0,
      splBalance: async () => 0,
    };
    const rep = await runDoctor({ env, readers });
    expect(rep.funded.deployer).toBe(true);
    expect(rep.funded.facilitator).toBe(false); // RHC gas ok, Base Sepolia gas missing
    expect(rep.rows.find((r) => r.role === "facilitator" && r.network === "base-sepolia")).toMatchObject({ ok: false, missing: "needs 0.001 ETH", backlog: "A6" });
    expect(rep.rows.find((r) => r.role === "hl-main")).toMatchObject({ ok: false, missing: "wallet not made (run make-wallets.sh)" });
    expect(JSON.parse(readFileSync(join(p.home, "doctor.json"), "utf8")).funded.deployer).toBe(true);
  });
});

describe("faucet", () => {
  test("devnet airdrop asserts the genesis, then requests and waits for confirmation", async () => {
    const methods: string[] = [];
    const stub = jsonRpcFetch({ getGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", requestAirdrop: "sig1", getSignatureStatuses: { value: [{ confirmationStatus: "confirmed" }] } });
    const r = await solanaAirdrop("11111111111111111111111111111111", 1, async (u, i) => (methods.push(JSON.parse(String(i?.body)).method), stub(u, i)), "https://api.devnet.solana.com", async () => {});
    expect(r).toEqual({ address: "11111111111111111111111111111111", sol: 1, signature: "sig1", error: null });
    expect(methods).toEqual(["getGenesisHash", "requestAirdrop", "getSignatureStatuses"]);
    await expect(solanaAirdrop("x", 5, stub, "https://api.devnet.solana.com")).rejects.toThrow("at most 2 SOL");
  });
});
