// Anchor worker rules R3, R4, R5, R6, R8, R12, R14 against a local anvil running the real CapstanReceiptAnchor.
import { afterEach, describe, expect, test } from "bun:test";
import { ConfigError, encryptKeystore, keystoreSigner, loadConfig, schema, type ServiceSigner } from "@capstan/core";
import { buildTree, pgReceiptStore } from "@capstan/receipts";
import { eq } from "drizzle-orm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex, toBytes } from "viem";
import { postRootDirect } from "../../../../packages/receipts/test/anvil";
import { anchorBacklog, anchorHour, AnchorRefused, assertPosterMatches, MAX_HOURS_PER_RUN } from "../../src/anchor";
import { job as merkleJob } from "../../src/jobs/merkle-anchor.job";
import { ANVIL, fixture, pastHour, PG, T, type Fixture } from "./fixture";

const run = PG && ANVIL ? describe : describe.skip;
let fx: Fixture | null = null;
afterEach(async () => {
  await fx?.drop();
  fx = null;
}, T);

const posterNonce = (f: Fixture) => f.rpc.getTransactionCount({ address: f.poster.address });

describe("merkle-anchor job definition", () => {
  test("schedule", () => {
    expect(merkleJob).toMatchObject({ name: "merkle-anchor", queue: "anchorHourly", schedule: { pattern: "5 * * * *" }, concurrency: 1 });
    expect(MAX_HOURS_PER_RUN).toBe(24);
  });
});

run("anchor on anvil", () => {
  test(
    "idempotent-post",
    async () => {
      fx = await fixture("idem");
      const h = pastHour(5);
      await fx.issueAt(h, 5, 1);
      const r1 = await anchorHour(h, fx.deps());
      expect(r1.status).toBe("posted");
      const n1 = await posterNonce(fx);
      const r2 = await anchorHour(h, fx.deps());
      expect(r2).toEqual({ status: "already_posted" });
      expect(await posterNonce(fx)).toBe(n1); // no second transaction
      const leaves = await pgReceiptStore(fx.db).byHour(h);
      const row = (await fx.db.select().from(schema.receiptRoots).where(eq(schema.receiptRoots.hourEpoch, h)))[0]!;
      expect(row).toMatchObject({ root: buildTree(leaves.map((l) => l.leaf)).root, leafCount: 5, status: "posted", txHash: r1.txHash });
    },
    T,
  );

  test(
    "mismatch-alert",
    async () => {
      fx = await fixture("mismatch");
      const h = pastHour(6);
      await fx.issueAt(h, 3, 2);
      const planted = keccak256(toHex("not our root"));
      await postRootDirect(fx.rpc, fx.poster, fx.anchor, h, planted, 3);
      const n0 = await posterNonce(fx);
      expect(await anchorHour(h, fx.deps())).toEqual({ status: "mismatch" });
      expect(fx.alerts).toEqual([expect.objectContaining({ kind: "anchor.root_mismatch", severity: "critical" })]);
      const row = (await fx.db.select().from(schema.receiptRoots).where(eq(schema.receiptRoots.hourEpoch, h)))[0]!;
      expect(row.status).toBe("mismatch");
      expect(row.onchainRoot).toBe(planted);
      // frozen: a re-run never posts and never reads the tree again
      expect(await anchorHour(h, fx.deps())).toEqual({ status: "mismatch" });
      expect(await posterNonce(fx)).toBe(n0);
      // a later hour still posts
      await fx.issueAt(h + 1, 2, 3);
      expect((await anchorHour(h + 1, fx.deps())).status).toBe("posted");
    },
    T,
  );

  test(
    "empty-hours",
    async () => {
      fx = await fixture("empty");
      const h = pastHour(10);
      await fx.issueAt(h, 2, 4);
      await fx.issueAt(h + 2, 3, 5);
      expect(await anchorHour(h + 1, fx.deps())).toEqual({ status: "empty" });
      const now = new Date((h + 3) * 3_600_000 + 5 * 60_000);
      const res = await anchorBacklog(fx.deps({ now: () => now }));
      expect(res.map((r) => [r.hourEpoch, r.status])).toEqual([
        [h, "posted"],
        [h + 2, "posted"],
      ]);
      expect(await anchorBacklog(fx.deps({ now: () => now }))).toEqual([]); // nothing left
      // the hour that has not ended yet is never anchored
      await fx.issueAt(h + 3, 1, 6);
      expect(await anchorBacklog(fx.deps({ now: () => now }))).toEqual([]);
    },
    T,
  );

  test(
    "bounded-backlog",
    async () => {
      fx = await fixture("backlog");
      const base = pastHour(60);
      for (let i = 0; i < 30; i++) await fx.issueAt(base + i, 1, 100 + i);
      const now = new Date((base + 30) * 3_600_000 + 5 * 60_000);
      const first = await anchorBacklog(fx.deps({ now: () => now }));
      expect(first.length).toBe(24);
      expect(first.every((r) => r.status === "posted")).toBe(true);
      expect(first.map((r) => r.hourEpoch)).toEqual(Array.from({ length: 24 }, (_, i) => base + i)); // in order
      const second = await anchorBacklog(fx.deps({ now: () => now }));
      expect(second.map((r) => r.hourEpoch)).toEqual(Array.from({ length: 6 }, (_, i) => base + 24 + i));
      const latest = await fx.rpc.readContract({ address: fx.anchor, abi: [{ type: "function", name: "latestHour", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }] as const, functionName: "latestHour" });
      expect(Number(latest)).toBe(base + 29);
    },
    T,
  );

  test(
    "gas-alert",
    async () => {
      // default threshold: 30 days of hourly posts at the measured fork gas. postRoot executed in 96,544 gas on a 4663
      // fork (test/fork/DeployFork.t.sol); with the 21,000 base and calldata a post is under 150,000 gas. RHC gas price
      // was 22,324,000 wei (chain-facts section 1). 720 x 150,000 x 22,324,000 = 2.41e15 wei, rounded up to 2.5e15.
      const cfg = loadConfig("workers", { DATABASE_URL: "postgres://x@127.0.0.1/x", REDIS_URL: "redis://127.0.0.1:1", ANCHOR_SIGNER: "dev", RECEIPT_SIGNER: "dev" });
      expect(BigInt(cfg.ANCHOR_MIN_BALANCE_WEI)).toBe(2_500_000_000_000_000n);
      expect(BigInt(cfg.ANCHOR_MIN_BALANCE_WEI) >= 30n * 24n * 150_000n * 22_324_000n).toBe(true);

      fx = await fixture("gas");
      const h = pastHour(7);
      await fx.issueAt(h, 1, 7);
      const bal = await fx.rpc.getBalance({ address: fx.poster.address });
      const res = await anchorHour(h, fx.deps({ minBalanceWei: bal + 1n }));
      expect(res.status).toBe("posted"); // posting continues while funds remain
      expect(fx.alerts).toEqual([expect.objectContaining({ kind: "anchor.poster_low_balance", severity: "warning" })]);
    },
    T,
  );

  test(
    "poster-matches-contract",
    async () => {
      // raw key variables are refused before anything loads
      expect(() => loadConfig("workers", { DATABASE_URL: "postgres://x@h/x", REDIS_URL: "redis://h:1", ANCHOR_PRIVATE_KEY: "0x01" })).toThrow(ConfigError);
      // a keystore signer (path + password file) for the contract's poster passes; any other signer is refused
      const dir = mkdtempSync(join(tmpdir(), "capstan-ks-"));
      const keyBytes = toBytes(keccak256(toHex("capstan-anchor-test-keystore"))); // test-key (public label)
      writeFileSync(join(dir, "k.json"), await encryptKeystore(keyBytes, "pw", { n: 1024, r: 8, p: 1 }));
      writeFileSync(join(dir, "pw"), "pw\n");
      const ks: ServiceSigner = await keystoreSigner(join(dir, "k.json"), join(dir, "pw"), { allowedChainIds: [31337] });
      fx = await fixture("poster");
      await expect(assertPosterMatches(fx.rpc, fx.anchor, ks.address)).rejects.toThrow(AnchorRefused);
      await assertPosterMatches(fx.rpc, fx.anchor, fx.poster.address);
      // the poster loads only from ANCHOR_KEYSTORE_PATH + ANCHOR_KEYSTORE_PASSWORD_FILE: without them the role refuses
      expect(() => loadConfig("workers", { DATABASE_URL: "postgres://x@h/x", REDIS_URL: "redis://h:1", ANCHOR_SIGNER: "keystore", RECEIPT_SIGNER: "dev" })).toThrow(/missing or invalid: ANCHOR_KEYSTORE_PATH, ANCHOR_KEYSTORE_PASSWORD_FILE/);
      // and the dev signer is refused off the local chain
      expect(() => loadConfig("workers", { DATABASE_URL: "postgres://x@h/x", REDIS_URL: "redis://h:1", ANCHOR_SIGNER: "dev", ANCHOR_CHAIN_ID: "46630", RECEIPT_SIGNER: "dev" })).toThrow(ConfigError);
    },
    T,
  );

  test(
    "mainnet-needs-arming",
    async () => {
      fx = await fixture("arming");
      const h = pastHour(8);
      await fx.issueAt(h, 1, 8);
      let signs = 0;
      const counting: ServiceSigner = { ...fx.poster, address: fx.poster.address, signMessage: fx.poster.signMessage, signTypedData: fx.poster.signTypedData, signTransaction: async (tx) => (signs++, fx!.poster.signTransaction!(tx)) };
      await expect(anchorHour(h, fx.deps({ chainId: 4663, signer: counting }))).rejects.toThrow(/needs ANCHOR_ARMED=1/);
      await expect(anchorHour(h, fx.deps({ chainId: 4663, signer: counting, armed: true }))).rejects.toThrow(/ANCHOR_ARMED_FILE/);
      await expect(anchorHour(h, fx.deps({ chainId: 4663, signer: counting, armed: true, armedFile: "/nonexistent/capstan-armed" }))).rejects.toThrow(/ANCHOR_ARMED_FILE/);
      const dir = mkdtempSync(join(tmpdir(), "capstan-armed-"));
      writeFileSync(join(dir, "armed"), "");
      // armed with the file, the RPC is still checked: this anvil is 31337, not 4663
      await expect(anchorHour(h, fx.deps({ chainId: 4663, signer: counting, armed: true, armedFile: join(dir, "armed") }))).rejects.toThrow(/RPC chain id 31337/);
      expect(signs).toBe(0); // refused before signing every time
      expect((await anchorHour(h, fx.deps({ signer: counting }))).status).toBe("posted"); // 31337 needs no arming
      expect(signs).toBe(1);
    },
    T,
  );
});
