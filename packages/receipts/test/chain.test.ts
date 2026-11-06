import { describe, expect, test } from "bun:test";
import type { Hex, Receipt } from "@capstan/schema";
import { drafts, issue, memoryLock, memoryStore, receiptHash, signReceipt, verifyChain, verifyReceiptSig } from "../src";
import { labelSigner } from "./helpers";

const OWNER = "0x1111111111111111111111111111111111111111" as Hex;
const OTHER = "0x2222222222222222222222222222222222222222" as Hex;
const RH = `0x${"ab".repeat(32)}` as Hex;

function deps(startMs = Date.UTC(2026, 10, 6, 12)) {
  let t = startMs;
  let n = 0;
  return {
    store: memoryStore(),
    signer: labelSigner("chain"),
    now: () => new Date(t++),
    id: () => `01JCHAIN${String(n++).padStart(18, "0")}`,
    lock: memoryLock(),
  };
}

const submit = (owner: Hex, i: number) =>
  drafts.orderSubmit({ owner, venue: "hyperliquid", marketId: "hyperliquid:-:BTC", buildId: `b${i}`, signedPayloadHash: RH, requestHash: RH, eligibilityDecisionId: `el${i}` });

describe("chain", () => {
  test("concurrent-linear", async () => {
    const d = deps();
    // yield inside the store so concurrent calls really interleave without the lock
    const head = d.store.head.bind(d.store);
    d.store.head = async (o) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      return head(o);
    };
    const append = d.store.append.bind(d.store);
    d.store.append = async (r, l, h) => {
      await new Promise((res) => setTimeout(res, Math.random() * 3));
      return append(r, l, h);
    };
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => issue(submit(OWNER, i), d)));
    expect(out.length).toBe(50);
    const ordered = [...out].sort((a, b) => (a.receiptId < b.receiptId ? -1 : 1));
    expect(ordered[0]!.prevReceiptHash).toBeNull();
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.prevReceiptHash).toBe(receiptHash(ordered[i - 1]!));
    // no fork: every prev hash is unique
    expect(new Set(out.map((r) => r.prevReceiptHash)).size).toBe(50);
    expect(verifyChain(out)).toEqual({ ok: true });
    for (const r of out) expect(verifyReceiptSig(r, [d.signer.address])).toBe(true);
    expect((await d.store.head(OWNER))!.hash).toBe(receiptHash(ordered[49]!));
    // a checksum-cased owner continues the same chain
    const next = await issue(submit(OWNER.toUpperCase().replace("0X", "0x") as Hex, 99), d);
    expect(next.prevReceiptHash).toBe(receiptHash(ordered[49]!));
  });

  test("concurrent-without-lock-forks", async () => {
    // the lock is what keeps the chain linear: with a no-op lock the same race forks
    const d = { ...deps(), lock: (_k: string, fn: () => Promise<Receipt>) => fn() };
    const head = d.store.head.bind(d.store);
    d.store.head = async (o) => {
      await new Promise((r) => setTimeout(r, 2));
      return head(o);
    };
    const append = d.store.append.bind(d.store);
    d.store.append = async (r, l, h) => {
      await new Promise((res) => setTimeout(res, 5));
      return append(r, l, h);
    };
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => issue(submit(OWNER, i), d)));
    expect(verifyChain(out).ok).toBe(false);
  });

  test("owners-independent", async () => {
    const d = deps();
    const a = await Promise.all(Array.from({ length: 10 }, (_, i) => issue(submit(OWNER, i), d)));
    const b = await Promise.all(Array.from({ length: 10 }, (_, i) => issue(submit(OTHER, i), d)));
    expect(verifyChain([...a, ...b])).toEqual({ ok: true });
    const anon = await issue(drafts.refusal({ requestHash: RH, eligibilityDecisionId: "el-anon" }), d);
    expect(anon.prevReceiptHash).toBeNull();
    expect(verifyChain([...a, anon, ...b])).toEqual({ ok: true });
  });

  test("broken-link", async () => {
    const d = deps();
    const out: Receipt[] = [];
    for (let i = 0; i < 8; i++) out.push(await issue(submit(OWNER, i), d));
    expect(verifyChain(out)).toEqual({ ok: true });
    // remove receipt 3: receipt 4 is the first broken link
    expect(verifyChain(out.filter((_, i) => i !== 3))).toEqual({ ok: false, brokenAt: out[4]!.receiptId });
    // remove the first: receipt 1 now starts the chain with a non-null link
    expect(verifyChain(out.slice(1))).toEqual({ ok: false, brokenAt: out[1]!.receiptId });
    // reorder: receipt 5 re-dated (and re-signed) before receipt 2
    const moved = await signReceipt({ ...out[5]!, ts: new Date(Date.parse(out[2]!.ts) - 0.5).toISOString(), receiptId: `${out[1]!.receiptId}Z` }, d.signer);
    const reordered = out.map((r, i) => (i === 5 ? moved : r));
    const res = verifyChain(reordered);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(moved.receiptId);
    // the array order given does not matter, only (ts, receiptId)
    expect(verifyChain([...out].reverse())).toEqual({ ok: true });
  });
});
