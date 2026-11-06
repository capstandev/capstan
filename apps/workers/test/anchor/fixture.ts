// Shared setup for the anchor tests: a migrated throwaway database, a fresh anchor on the local anvil (ANVIL_URL,
// chain 31337) with a labelled dev poster, and helpers to issue receipts into chosen hours.
import { closeDb, createDb, createTempDatabase, devSigner, logger, type Db, type ServiceSigner } from "@capstan/core";
import { createReceiptService } from "@capstan/receipts";
import type { Hex } from "@capstan/schema";
import type { PublicClient } from "viem";
import { anvilClient, deployAnchor, posterFor } from "../../../../packages/receipts/test/anvil";
import { draft } from "../../../../packages/receipts/test/pg/draft";
import { NonceManager, type AnchorDeps } from "../../src/anchor";

export const PG = process.env.DATABASE_URL;
export const ANVIL = process.env.ANVIL_URL;
export const T = 120_000;
export const quiet = logger("test", { sink: () => {} });

export interface Fixture {
  db: Db;
  rpc: PublicClient;
  poster: ServiceSigner;
  anchor: Hex;
  deployBlock: bigint;
  alerts: { kind: string; severity: string; detail: unknown }[];
  deps(over?: Partial<AnchorDeps>): AnchorDeps;
  issueAt(hour: number, n: number, base: number): Promise<void>;
  drop(): Promise<void>;
}

let seq = 0;
export async function fixture(label: string): Promise<Fixture> {
  const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_an" });
  const db = createDb(t.url, { max: 5 });
  const rpc = anvilClient(ANVIL);
  const poster = await posterFor(rpc, `${label}:${process.pid}:${seq++}`);
  const { address, block } = await deployAnchor(rpc, poster.address, `${label}:${process.pid}:${seq}`);
  const alerts: Fixture["alerts"] = [];
  const nonces = new NonceManager(db, rpc, "anchor-poster", poster.address, 31337);
  await nonces.resync();
  const receiptSigner = devSigner(31337, `fixture-receipts:${label}`);
  return {
    db,
    rpc,
    poster,
    anchor: address,
    deployBlock: block,
    alerts,
    deps: (over = {}) => ({
      db,
      rpc,
      signer: poster,
      anchor: address,
      chainId: 31337,
      nonces,
      log: quiet,
      now: () => new Date(),
      publish: async (_c, p) => void alerts.push(p as Fixture["alerts"][number]),
      armed: false,
      minBalanceWei: 1n,
      receiptTimeoutMs: 30_000,
      pollingIntervalMs: 50,
      ...over,
    }),
    async issueAt(hour, n, s) {
      let k = 0;
      const svc = createReceiptService({ db, signer: receiptSigner, now: () => new Date(hour * 3_600_000 + 1000 * k++) });
      for (let i = 0; i < n; i++) await svc.issue(draft(`0x${String((s + i) % 4).padStart(40, "f")}` as Hex, s * 1000 + i));
    },
    async drop() {
      await closeDb(db);
      await t.drop();
    },
  };
}

/** A past hour on anvil's clock (anvil follows the wall clock). */
export const pastHour = (back: number): number => Math.floor(Date.now() / 3_600_000) - back;
