// R4: on the anvil fork of RHC (RHC_FORK_URL, local only), deploy CPST and CPSTLock from the contracts/ sources
// (compiled with forge into a temp dir), lock from a fresh key, and tierOf reads the tier from chain: 99,999.999 CPST
// is free, topping up to 100,000 is lock_holder. With DATABASE_URL the lock-snapshot job also snapshots it.
// Skips without RHC_FORK_URL.
import { describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, logger } from "@capstan/core";
import { ADDRESSES, type Hex } from "@capstan/schema";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseAbi, parseUnits, type Abi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { runLockSnapshot } from "../../../../apps/workers/src/jobs/lock-snapshot.job";
import { lockOwnersFromLogs, snapshotAt } from "../../src/snapshots";
import { tierOf, viemLockReader } from "../../src/tier-of";
import { setTokenBalance } from "../../../x402/test/helpers/chain";

const FORK = process.env.RHC_FORK_URL;
const PG = process.env.DATABASE_URL;
const FORGE = join(homedir(), ".foundry/bin/forge");
const CONTRACTS = join(import.meta.dir, "../../../../contracts");
const chain = (url: string) => ({ id: 4663, name: "rhc-fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } }) as const;

function compile(): Record<"CPST" | "CPSTLock", { abi: Abi; bytecode: Hex }> {
  const out = mkdtempSync(join(tmpdir(), "capstan-plans-contracts-"));
  try {
    const r = spawnSync(FORGE, ["build", "--root", CONTRACTS, "--out", join(out, "out"), "--cache-path", join(out, "cache"), "--skip", "test", "--skip", "script", "--offline"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`forge build failed: ${r.stderr || r.stdout}`);
    const read = (f: string, n: string) => {
      const j = JSON.parse(readFileSync(join(out, "out", f, `${n}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
      return { abi: j.abi, bytecode: j.bytecode.object };
    };
    return { CPST: read("CPST.sol", "CPST"), CPSTLock: read("CPSTLock.sol", "CPSTLock") };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const LOCK_WRITE = parseAbi(["function lock(uint256 amount, uint64 duration)"]);

(FORK && existsSync(FORGE) ? describe : describe.skip)("RHC fork: lock tier from chain", () => {
  test("reads-chain", async () => {
    const host = new URL(FORK!).hostname;
    expect(host === "127.0.0.1" || host === "localhost").toBe(true);
    const pc = createPublicClient({ transport: http(FORK!) });
    expect(await pc.getChainId()).toBe(4663);
    const art = compile();
    const tc = createTestClient({ mode: "anvil", transport: http(FORK!) });
    // fresh keys (in memory only); never the anvil default accounts on an RHC fork
    const deployer = privateKeyToAccount(generatePrivateKey());
    const locker = privateKeyToAccount(generatePrivateKey());
    for (const a of [deployer, locker]) await tc.setBalance({ address: a.address, value: 10n ** 19n });
    const dw = createWalletClient({ account: deployer, chain: chain(FORK!), transport: http(FORK!) });
    // CPST mints the supply to a contract (the brand Safe in production); on the fork any contract with code will do
    const h1 = await dw.deployContract({ abi: art.CPST.abi, bytecode: art.CPST.bytecode, args: [ADDRESSES.usdgRhc.address] });
    const cpst = (await pc.waitForTransactionReceipt({ hash: h1 })).contractAddress!;
    const h2 = await dw.deployContract({ abi: art.CPSTLock.abi, bytecode: art.CPSTLock.bytecode, args: [cpst] });
    const r2 = await pc.waitForTransactionReceipt({ hash: h2 });
    const lockAddr = r2.contractAddress!;
    expect(await pc.readContract({ address: cpst, abi: erc20Abi, functionName: "decimals" })).toBe(18);
    await setTokenBalance(FORK!, cpst, locker.address, parseUnits("200000", 18));

    const lw = createWalletClient({ account: locker, chain: chain(FORK!), transport: http(FORK!) });
    await pc.waitForTransactionReceipt({ hash: await lw.writeContract({ address: cpst, abi: erc20Abi, functionName: "approve", args: [lockAddr, parseUnits("200000", 18)] }) });
    await pc.waitForTransactionReceipt({ hash: await lw.writeContract({ address: lockAddr, abi: LOCK_WRITE, functionName: "lock", args: [parseUnits("99999.999", 18), 0n] }) });

    const reader = viemLockReader(pc, lockAddr);
    const t1 = await tierOf({ owner: locker.address }, { db: null, lock: reader, cacheTtlMs: 0 });
    expect(t1.tier).toBe("free");
    expect(t1.locked).toBe(parseUnits("99999.999", 18));
    await pc.waitForTransactionReceipt({ hash: await lw.writeContract({ address: lockAddr, abi: LOCK_WRITE, functionName: "lock", args: [parseUnits("0.001", 18), 30n * 86400n] }) });
    const t2 = await tierOf({ owner: locker.address }, { db: null, lock: reader, cacheTtlMs: 0 });
    expect(t2).toMatchObject({ tier: "lock_holder", multiplier: 2, builderFee: { hlTenthsBp: 10, asterRate: "0.0001" } });

    // owners come back from the Locked events (chunked getLogs)
    const owners = await lockOwnersFromLogs(pc, lockAddr, r2.blockNumber, 2n);
    expect(owners).toEqual([locker.address.toLowerCase() as Hex]);

    if (PG) {
      const t = await createTempDatabase(PG, { migrated: true, prefix: "capstan_lockfork" });
      const db = createDb(t.url, { max: 2 });
      try {
        const now = new Date("2026-11-06T09:00:00Z");
        const n = await runLockSnapshot({ db, redis: null, cache: null, log: logger("t", { sink: () => {} }), now: () => now }, { lock: reader, lockOwners: () => lockOwnersFromLogs(pc, lockAddr, r2.blockNumber) });
        expect(n).toBe(1);
        const s = await snapshotAt(db, new Date("2026-11-06T00:00:00Z"));
        expect(s).toEqual([{ ts: new Date("2026-11-06T00:00:00Z"), owner: locker.address.toLowerCase() as Hex, amount: parseUnits("100000", 18) }]);
      } finally {
        await closeDb(db);
        await t.drop();
      }
    }
  }, 180_000);
});
