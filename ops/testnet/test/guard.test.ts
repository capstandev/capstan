// Todo 41 R1 (refuses-mainnet) and R2 (no-secrets).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSignedCanary, assertHlTestnetConfig, hlSignedProbe } from "../../../apps/workers/src/jobs/canary-signed.job";
import { solanaAirdrop } from "../faucet";
import {
  assertAsterTestnet,
  assertEvmTestnet,
  assertHlTestnet,
  assertLighterTestnet,
  assertSolanaDevnet,
  assertTestnetChainId,
  assertTestnetHost,
  findSecrets,
  MAINNET_HOSTS,
  NetworkRefused,
} from "../guard";
import { runAll } from "../run-all";
import { fakeDoctor, jsonRpcFetch, stubCast, tempHome } from "./helpers";

const HERE = resolve(import.meta.dir, "..");
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

describe("guard", () => {
  test("refuses-mainnet", async () => {
    // chain ids: mainnet answers, mainnet targets, and a mismatch are all refused
    expect(() => assertTestnetChainId(4663, 46630)).toThrow(NetworkRefused);
    expect(() => assertTestnetChainId(8453, 84532)).toThrow("Base mainnet");
    expect(() => assertTestnetChainId(4663, 4663)).toThrow("not a testnet");
    expect(() => assertTestnetChainId(8453, 8453)).toThrow("not a testnet");
    expect(() => assertTestnetChainId(31337, 46630)).toThrow("expected 46630");
    expect(() => assertTestnetChainId(46630, 46630)).not.toThrow();
    expect(() => assertTestnetChainId(84532, 84532)).not.toThrow();
    // hosts: every mainnet host and any unknown host
    for (const h of MAINNET_HOSTS) expect(() => assertTestnetHost(`https://${h}/x`)).toThrow("mainnet host");
    expect(() => assertTestnetHost("https://example.com")).toThrow("not a known testnet host");
    expect(() => assertTestnetHost("https://rpc.testnet.chain.robinhood.com")).not.toThrow();
    expect(() => assertTestnetHost("http://127.0.0.1:22445")).not.toThrow();
    // eth_chainId over a stub RPC that answers 4663 (0x1237) and 8453 (0x2105)
    await expect(assertEvmTestnet("http://127.0.0.1:1", 46630, jsonRpcFetch({ eth_chainId: "0x1237" }))).rejects.toThrow("Robinhood Chain mainnet");
    await expect(assertEvmTestnet("http://127.0.0.1:1", 84532, jsonRpcFetch({ eth_chainId: "0x2105" }))).rejects.toThrow("Base mainnet");
    await expect(assertEvmTestnet("https://rpc.mainnet.chain.robinhood.com", 46630, jsonRpcFetch({ eth_chainId: "0xb626" }))).rejects.toThrow("mainnet host");
    expect(await assertEvmTestnet("http://127.0.0.1:1", 46630, jsonRpcFetch({ eth_chainId: "0xb626" }))).toBe(46630);
    // Solana: mainnet genesis refused, devnet accepted; the airdrop asks for nothing on mainnet
    await expect(assertSolanaDevnet("https://api.devnet.solana.com", jsonRpcFetch({ getGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }))).rejects.toThrow("not Solana devnet");
    await expect(assertSolanaDevnet("https://api.mainnet-beta.solana.com", jsonRpcFetch({ getGenesisHash: "x" }))).rejects.toThrow("mainnet host");
    let asked = false;
    const spy = jsonRpcFetch({ getGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
    await expect(solanaAirdrop("11111111111111111111111111111111", 1, async (u, i) => ((asked ||= String(i?.body).includes("requestAirdrop")), spy(u, i)), "https://api.devnet.solana.com")).rejects.toThrow(NetworkRefused);
    expect(asked).toBe(false);
    // venues
    expect(() => assertHlTestnet("https://api.hyperliquid.xyz/info", "Testnet")).toThrow("not the Hyperliquid testnet host");
    expect(() => assertHlTestnet("https://api.hyperliquid-testnet.xyz/info", "Mainnet")).toThrow("not Testnet");
    expect(() => assertLighterTestnet("https://mainnet.zklighter.elliot.ai", 300)).toThrow("not a Lighter testnet host");
    expect(() => assertLighterTestnet("https://api.rh.lighter.xyz", 300)).toThrow("not a Lighter testnet host");
    expect(() => assertLighterTestnet("https://testnet.zklighter.elliot.ai", 304)).toThrow("not the testnet id 300");
    expect(() => assertLighterTestnet("https://api.rh-testnet.lighter.xyz", 300)).not.toThrow();
    expect(() => assertAsterTestnet("https://fapi.asterdex.com", 714)).toThrow("not the Aster testnet host");
    expect(() => assertAsterTestnet("https://fapi.asterdex-testnet.com", 1666)).toThrow("not the testnet id 714");
    // the signed canary refuses outside testnet, and its HL probe refuses a mainnet config before any request
    const r = await runSignedCanary({ log: quiet }, { env: { CAPSTAN_NETWORK: "mainnet", HL_TESTNET_KEYSTORE: "/x", HL_TESTNET_PASSWORD_FILE: "/y" }, hl: async () => ({ venue: "hyperliquid", status: "ok", detail: "must not run" }) });
    expect(r).toEqual([{ venue: "hyperliquid", status: "skipped", detail: "refused: not testnet" }]);
    expect(() => assertHlTestnetConfig({ network: "Mainnet", infoUrl: "https://api.hyperliquid.xyz/info", exchangeUrl: "https://api.hyperliquid.xyz/exchange" })).toThrow("not Testnet");
    let called = false;
    const http = { postJson: async () => ((called = true), {}) } as never;
    await expect(hlSignedProbe({ owner: "0x0000000000000000000000000000000000000001", sign: async () => ({ r: "0x1", s: "0x1", v: 27 }), http, cfg: { network: "Testnet", infoUrl: "https://api.hyperliquid.xyz/info", exchangeUrl: "https://api.hyperliquid.xyz/exchange", wsUrl: "wss://api.hyperliquid.xyz/ws" } as never })).rejects.toThrow("not the Hyperliquid testnet host");
    expect(called).toBe(false);
    // make-safe.sh: a mainnet RPC URL and an RPC answering 4663 are both refused before any send
    const { dir, env } = tempHome();
    const tools = stubCast(dir, 4663);
    const a = Bun.spawnSync(["/bin/bash", join(HERE, "make-safe.sh")], { env: { ...process.env, ...env, TESTNET_TOOL_DIR: tools, RPC_URL: "https://rpc.mainnet.chain.robinhood.com" } });
    expect(a.exitCode).toBe(1);
    expect(a.stdout.toString()).toContain("refuse:");
    const b = Bun.spawnSync(["/bin/bash", join(HERE, "make-safe.sh")], { env: { ...process.env, ...env, TESTNET_TOOL_DIR: tools, RPC_URL: "http://127.0.0.1:22445" } });
    expect(b.exitCode).toBe(1);
    expect(b.stdout.toString()).toContain("refuse: chain id 4663, expected 46630");
    expect(readFileSync(join(tools, "calls.log"), "utf8").split("\n").filter(Boolean)).toEqual(["chain-id --rpc-url http://127.0.0.1:22445"]);
    // make-wallets-vps.sh refuses on this Mac
    const v = Bun.spawnSync(["/bin/bash", join(HERE, "make-wallets-vps.sh")], { env: { ...process.env, ...env, CAPSTAN_RUNNER: "" } });
    expect(v.exitCode).toBe(1);
    expect(v.stdout.toString()).toContain("VPS only");
  });

  test("no-secrets", async () => {
    // the scanner itself: a password value and a bare 64-hex are flagged; a tx hash inside an explorer link is not
    const hex64 = "ab".repeat(32);
    expect(findSecrets(`x 0x${hex64} y`)).toHaveLength(1);
    expect(findSecrets(`see https://explorer.testnet.chain.robinhood.com/tx/0x${hex64}`)).toEqual([]);
    expect(findSecrets("the password is hunter2hunter2", ["hunter2hunter2"])).toEqual(["a password value appears in the text"]);

    // make-wallets.sh in a throwaway home: output (stdout + stderr) holds addresses only
    const { dir, env } = tempHome();
    const r = Bun.spawnSync(["/bin/bash", join(HERE, "make-wallets.sh")], { env: { ...process.env, ...env } });
    expect(r.exitCode).toBe(0);
    const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
    const home = env.CAPSTAN_TESTNET_HOME!;
    const passwords = readdirSync(home).filter((f) => f.endsWith(".password")).map((f) => readFileSync(join(home, f), "utf8"));
    expect(passwords.length).toBe(15);
    for (const f of readdirSync(home).filter((x) => x.endsWith(".password"))) expect((Bun.spawnSync(["stat", "-f", "%Lp", join(home, f)]).stdout.toString().trim())).toBe("600");
    expect(findSecrets(out, passwords)).toEqual([]);
    expect(out).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(out.split("\n").filter((l) => / (created|exists) \(/.test(l))).toHaveLength(15);
    // a second run keeps every wallet
    const again = Bun.spawnSync(["/bin/bash", join(HERE, "make-wallets.sh")], { env: { ...process.env, ...env } }).stdout.toString();
    expect(again).not.toContain(" created ");
    expect(JSON.parse(readFileSync(join(home, "addresses.json"), "utf8"))).toMatchObject({ deployer: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/), "sol-payer": expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) });

    // run-all with a suite that prints a password (the spy): the report keeps counts only and passes the scan
    const seen: Record<string, string>[] = [];
    const exec = async (cmd: string[], e: Record<string, string>) => {
      seen.push(e);
      return { code: 1, out: `error: leaked ${passwords[0]} and 0x${hex64}\n 0 pass\n 1 fail\n` };
    };
    const reportDir = join(dir, "reports");
    Bun.spawnSync(["mkdir", "-p", reportDir]);
    const res = await runAll({ env, exec, doctor: async () => fakeDoctor(["hl-main", "hl-builder"]), canaries: false, reportDir, airdrop: async () => ({ address: "x", sol: 1, signature: "sig", error: null }) });
    expect(seen.length).toBe(1);
    expect(seen[0]!.HL_TESTNET_PASSWORD_FILE).toBe(join(home, "capstan-testnet-hl-main.password")); // a path, never the value
    const text = readFileSync(res.report, "utf8");
    expect(findSecrets(text, passwords)).toEqual([]);
    expect(text).toContain("[output withheld: the secret scan flagged it]");
    expect(existsSync(res.report)).toBe(true);
  }, 60_000);
});
