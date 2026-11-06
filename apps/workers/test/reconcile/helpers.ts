// Reconciler test setup: a migrated throwaway database, planted builds, orders and receipts, recorded public venue data
// (userFillsByTime for one address on 2026-11-02 and the matching builder CSV), and a literal-only LZ4 writer for
// synthetic CSVs.
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { createReceiptService, drafts, nobleSigner, type ReceiptService } from "@capstan/receipts";
import type { HlFill } from "@capstan/adapter-hyperliquid";
import type { Hex, Receipt, VenueId } from "@capstan/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes, keccak256, toBytes } from "viem";
import { xxh32, type CsvFetcher } from "../../src/reconcile";
import { FILLS, FILLS_BUILDER, FILLS_DAY, FILLS_USER } from "./fixtures/userfills-2026-11-02";

export { FILLS, FILLS_BUILDER, FILLS_DAY, FILLS_USER };
export const PG = process.env.DATABASE_URL;
export const FIX = join(import.meta.dir, "fixtures");
export const CSV_ALL = new Uint8Array(readFileSync(join(FIX, `builder-${FILLS_BUILDER}-20261102.csv.lz4`)));
export const CSV_ONE_USER = new Uint8Array(readFileSync(join(FIX, "builder-20261102-one-user.csv.lz4")));
export const CSV_LINKED = new Uint8Array(readFileSync(join(FIX, "builder-20261102-linked.csv.lz4")));
export const BUILDER = FILLS_BUILDER as Hex;
export const RUN_DAY = "2026-11-05"; // CSV day = RUN_DAY - 3 = FILLS_DAY

const h32 = (n: number | string) => keccak256(toBytes(`capstan-recon:${n}`));

export interface Planted {
  db: Db;
  receipts: ReceiptService;
  /** A build + order (+ receipt unless `receipt: false`). Returns the order id and receipt. */
  order(o: { owner: Hex; venue?: VenueId; marketId?: string; oid: string; status?: string; at?: number; receipt?: boolean }): Promise<{ orderId: string; receipt: Receipt | null }>;
  /** A receipt only (direct mode: the SDK submitted and claimed it). */
  claim(o: { owner: Hex; venue?: VenueId; marketId?: string; oid: string; at?: number }): Promise<Receipt>;
  drop(): Promise<void>;
}

let seq = 0;
export async function plant(label: string, clock: { ms: number } = { ms: Date.parse(`${FILLS_DAY}T12:00:00Z`) }): Promise<Planted> {
  const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_rc" });
  const db = createDb(t.url, { max: 4 });
  const receipts = createReceiptService({ db, signer: nobleSigner(hexToBytes(keccak256(toBytes(`capstan-recon-receipts:${label}`)))), now: () => new Date(clock.ms) }); // test-key (derived from a public label)
  async function issue(kind: "submit" | "claim", o: { owner: Hex; venue: VenueId; marketId: string; oid: string; buildId: string; at: number }) {
    clock.ms = o.at;
    const base = { owner: o.owner, venue: o.venue, marketId: o.marketId, buildId: o.buildId, signedPayloadHash: h32(`sp:${o.oid}`), requestHash: h32(`rq:${o.oid}:${seq++}`), eligibilityDecisionId: `eld_${o.oid}`, venueOrderId: o.oid };
    return receipts.issue(kind === "submit" ? drafts.orderSubmit(base) : drafts.orderClaim(base));
  }
  return {
    db,
    receipts,
    async order(o) {
      const venue = o.venue ?? "hyperliquid";
      const marketId = o.marketId ?? "hyperliquid:-:BTC";
      const at = o.at ?? Date.parse(`${FILLS_DAY}T00:00:01Z`);
      const buildId = `bld_${label}_${o.oid}_${seq++}`;
      await db.insert(schema.orderBuilds).values({ id: buildId, owner: o.owner.toLowerCase(), venue, marketId, intent: {}, payload: {}, preview: {}, eligibilityDecisionId: `eld_${o.oid}`, expiresAt: new Date(at + 30_000) });
      const orderId = `ord_${label}_${o.oid}_${seq++}`;
      await db.insert(schema.orders).values({ id: orderId, buildId, venue, marketId, owner: o.owner.toLowerCase(), venueOrderId: o.oid, signedPayloadHash: h32(`sp:${o.oid}:${seq++}`), mode: "relay", status: o.status ?? "filled", builderFeeBps: 1, submittedAt: new Date(at) });
      const receipt = o.receipt === false ? null : await issue("submit", { owner: o.owner, venue, marketId, oid: o.oid, buildId, at });
      return { orderId, receipt };
    },
    async claim(o) {
      return issue("claim", { owner: o.owner, venue: o.venue ?? "hyperliquid", marketId: o.marketId ?? "hyperliquid:-:BTC", oid: o.oid, buildId: `bld_direct_${o.oid}`, at: o.at ?? Date.parse(`${FILLS_DAY}T00:00:01Z`) });
    },
    async drop() {
      await closeDb(db);
      await t.drop();
    },
  };
}

/** marketId of a recorded fill's coin. */
export const marketOf = (coin: string): string => (coin.includes(":") ? `hyperliquid:${coin}` : `hyperliquid:-:${coin}`);

/** A fake HL reader over recorded fills per owner; `fail` owners throw. Records every call. */
export function fakeHl(byOwner: Record<string, HlFill[]>, fail: string[] = []) {
  const calls: { owner: string; start: number; end?: number }[] = [];
  return {
    calls,
    hl: {
      async userFills(owner: Hex, start: number, end?: number) {
        calls.push({ owner, start, ...(end !== undefined ? { end } : {}) });
        if (fail.includes(owner.toLowerCase())) throw new Error(`venue down for ${owner}`);
        return (byOwner[owner.toLowerCase()] ?? []).filter((f) => f.time >= start && (end === undefined || f.time <= end));
      },
    },
  };
}

export function fakeCsv(days: Record<string, Uint8Array | 403>) {
  const calls: { addr: string; day: string }[] = [];
  const csv: CsvFetcher = {
    async get(addr, day) {
      calls.push({ addr, day });
      return days[day] ?? 403;
    },
  };
  return { csv, calls };
}

export function collector() {
  const events: { kind: string; detail: Record<string, unknown> }[] = [];
  return { events, publish: async (_c: string, p: unknown) => void events.push(p as never), reasons: () => events.map((e) => e.detail.reason) };
}

/** An LZ4 frame holding `text` as literal-only blocks (valid LZ4, no compression), with a content checksum. */
export function lz4Literal(text: string | Uint8Array, blockSize = 60 * 1024): Uint8Array {
  const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const out: number[] = [0x04, 0x22, 0x4d, 0x18];
  const desc = [0x64, 0x40]; // version 01, independent blocks, content checksum; 64 KB blocks
  out.push(...desc, (xxh32(new Uint8Array(desc)) >>> 8) & 0xff);
  const le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (let p = 0; p < data.length; p += blockSize) {
    const lit = data.subarray(p, Math.min(p + blockSize, data.length));
    const block: number[] = [];
    let n = lit.length;
    if (n >= 15) {
      block.push(0xf0);
      n -= 15;
      while (n >= 255) {
        block.push(255);
        n -= 255;
      }
      block.push(n);
    } else block.push(n << 4);
    block.push(...lit);
    out.push(...le(block.length), ...block);
  }
  out.push(...le(0), ...le(xxh32(data)));
  return new Uint8Array(out);
}
