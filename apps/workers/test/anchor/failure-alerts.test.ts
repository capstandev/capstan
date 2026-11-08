// r1:6 F10: a failed anchor send (estimate, sign, send, receipt or revert) only logged, and nothing watched how far
// anchoring had fallen behind, so a revert loop or a dead RPC stopped anchoring silently while receipts kept
// verifying as "not_posted". Now a failed send raises anchor.post_failed (critical) and the ops-alerts check
// anchorLag raises anchor.lagging when the oldest unanchored non-empty hour is 2 or more hours old.
// Runs on Postgres (DATABASE_URL) with a stub RPC; skips without it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, devSigner, logger, type Db } from "@capstan/core";
import { createReceiptService } from "@capstan/receipts";
import type { Hex } from "@capstan/schema";
import { draft } from "../../../../packages/receipts/test/pg/draft";
import { anchorBacklog, anchorHour, anchorLag, type AnchorDeps, type AnchorRpc } from "../../src/anchor";
import { ZERO32 } from "../../src/anchor/abi";

const PG = process.env.DATABASE_URL;
const quiet = logger("test", { sink: () => {} });

(PG ? describe : describe.skip)("anchor failure alerts (r1:6 F10)", () => {
  let db: Db;
  let drop: () => Promise<void>;
  const hourNow = Math.floor(Date.now() / 3_600_000);
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_anf" });
    db = createDb(t.url, { max: 4 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
    const signer = devSigner(31337, "anchor-failure-alerts");
    for (const back of [3, 1]) {
      const hour = hourNow - back;
      let k = 0;
      const svc = createReceiptService({ db, signer, now: () => new Date(hour * 3_600_000 + 1000 * k++) });
      for (let i = 0; i < 2; i++) await svc.issue(draft(`0x${String(i).padStart(40, "f")}` as Hex, back * 1000 + i));
    }
  }, 60_000);
  afterAll(async () => drop?.(), 30_000);

  const deps = (alerts: { kind: string; severity: string }[], rpcOver: Partial<AnchorRpc> = {}): AnchorDeps => ({
    db,
    rpc: {
      getChainId: async () => 31337,
      readContract: (async (a: { functionName: string }) => (a.functionName === "rootOf" ? [ZERO32, 0, 0n] : 0n)) as never,
      getBalance: async () => 10n ** 18n,
      estimateGas: async () => Promise.reject(new Error("execution reverted")),
      getBlock: (async () => ({ baseFeePerGas: 1n })) as never,
      sendRawTransaction: async () => `0x${"11".repeat(32)}` as Hex,
      waitForTransactionReceipt: (async () => ({ status: "success" })) as never,
      ...rpcOver,
    } as AnchorRpc,
    signer: { address: "0x00000000000000000000000000000000000000d1", signTransaction: async () => "0x02" } as never,
    anchor: "0x00000000000000000000000000000000000000d2",
    chainId: 31337,
    nonces: { next: async () => 0, confirm: async () => 0, resync: async () => undefined } as never,
    log: quiet,
    now: () => new Date(),
    publish: async (_c, p) => void alerts.push(p as { kind: string; severity: string }),
    armed: false,
    minBalanceWei: 1n,
  });

  test("a failed send raises anchor.post_failed (critical)", async () => {
    const alerts: { kind: string; severity: string }[] = [];
    expect((await anchorHour(hourNow - 3, deps(alerts))).status).toBe("failed");
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "anchor.post_failed", severity: "critical" }));
  });

  test("an RPC error before the send raises anchor.post_failed from the backlog run and still throws", async () => {
    const alerts: { kind: string; severity: string }[] = [];
    await expect(anchorBacklog(deps(alerts, { getChainId: async () => Promise.reject(new Error("rpc down")) }))).rejects.toThrow("rpc down");
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "anchor.post_failed", severity: "critical" }));
  });

  test("anchorLag reports the oldest unanchored non-empty hour once it is 2 or more hours behind", async () => {
    const lag = await anchorLag(db, new Date());
    expect(lag).toMatchObject({ oldestUnanchored: hourNow - 3, hoursBehind: 2 });
    // one hour later than the newest receipt hour and nothing older pending: not lagging
    const fresh = await anchorLag(db, new Date((hourNow - 1) * 3_600_000 + 60_000));
    expect(fresh).toBeNull();
  });
});
