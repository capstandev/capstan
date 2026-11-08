// R11: verifyReceipt works offline from the receipt, its proof and one public RPC read of the anchor. A local anvil
// (port 22045, this lane's) runs the real CapstanReceiptAnchor; no Capstan API is called for any of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildTree, drafts, issue, memoryLock, memoryStore, nobleSigner, proofFor, receiptLeaf } from "@capstan/receipts";
import type { Hex, Receipt } from "@capstan/schema";
import { encodeFunctionData } from "viem";
import { anvilClient, deployAnchor, labelAddress, sendAs } from "../../receipts/test/anvil";
import { sha256Jcs } from "../src/bytes";
import { SdkError } from "../src/errors";
import { rpcAnchorReader, verifyReceiptOffline } from "../src/receipts";
import { labelAddr, testKey } from "./helpers";

const ANVIL = join(homedir(), ".foundry/bin/anvil");
const PORT = 22045;
const RPC = `http://127.0.0.1:${PORT}`;
const have = existsSync(ANVIL);
let proc: ChildProcess | null = null;

beforeAll(async () => {
  if (!have) return;
  proc = spawn(ANVIL, ["--port", String(PORT), "--silent", "--chain-id", "31337"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error("anvil did not start");
}, 30_000);
afterAll(() => {
  if (proc?.pid) process.kill(proc.pid); // only the anvil this file started, by PID
});

const POST_ROOT = [{ type: "function", name: "postRoot", stateMutability: "nonpayable", inputs: [{ name: "hourEpoch", type: "uint64" }, { name: "root", type: "bytes32" }, { name: "leafCount", type: "uint32" }], outputs: [] }] as const;

async function hourOfReceipts(ts: string, n: number) {
  const signer = nobleSigner(testKey("receipt-signer"));
  const store = memoryStore();
  const lock = memoryLock();
  let i = 0;
  const out: Receipt[] = [];
  for (let k = 0; k < n; k++) out.push(await issue(drafts.refusal({ owner: labelAddr(`o${k % 2}`), requestHash: sha256Jcs({ k }), eligibilityDecisionId: "elig" }), { store, signer, now: () => new Date(Date.parse(ts) + k * 1000), id: () => `rcpt-${++i}`, lock }));
  const leaves = out.map((r) => receiptLeaf(r));
  const tree = buildTree(leaves);
  return { signer, receipts: out, tree, hour: Math.floor(Date.parse(ts) / 3_600_000) };
}

describe("receipts", () => {
  test.skipIf(!have)("independent-verify", async () => {
    const rpc = anvilClient(RPC);
    const poster = labelAddress("sdk-poster");
    const { address } = await deployAnchor(rpc, poster, "sdk-receipts");
    const h = await hourOfReceipts("2026-01-01T10:15:00.000Z", 5);
    await sendAs(rpc, poster, { to: address, data: encodeFunctionData({ abi: POST_ROOT, functionName: "postRoot", args: [BigInt(h.hour), h.tree.root, 5] }) });

    // the only network calls are to the public RPC: eth_chainId once, then eth_call rootOf
    const calls: string[] = [];
    const spy = (async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${String(u)} ${JSON.parse(String(init?.body)).method}`);
      return fetch(u, init);
    }) as typeof fetch;
    const anchor = rpcAnchorReader({ rpcUrl: RPC, address, chainId: 31337, fetch: spy });
    const signers = [{ address: h.signer.address as Hex }];
    for (let i = 0; i < 5; i++) {
      const v = await verifyReceiptOffline(h.receipts[i]!, { hourEpoch: h.hour, proof: proofFor(h.tree, i), root: h.tree.root }, { signers, anchor });
      expect(v).toEqual({ valid: true, status: "valid", checks: { signature: true, leaf: true, proof: true, onChainRoot: true } });
    }
    expect(calls).toEqual([`${RPC} eth_chainId`, ...Array(5).fill(`${RPC} eth_call`)]);

    // a tampered receipt, a wrong signer list, a wrong proof, a proof for another hour
    const r0 = h.receipts[0]!;
    const p0 = { hourEpoch: h.hour, proof: proofFor(h.tree, 0), root: h.tree.root };
    expect((await verifyReceiptOffline({ ...r0, venueOrderId: "999" }, p0, { signers, anchor })).valid).toBe(false);
    expect((await verifyReceiptOffline(r0, p0, { signers: [{ address: labelAddr("other-signer") }], anchor })).checks.signature).toBe(false);
    expect((await verifyReceiptOffline(r0, { ...p0, proof: proofFor(h.tree, 1) }, { signers, anchor })).checks.proof).toBe(false);
    expect((await verifyReceiptOffline(r0, { ...p0, hourEpoch: h.hour - 1 }, { signers, anchor })).valid).toBe(false);

    // the server claims another root than the chain holds: onChainRoot false, invalid
    const other = await hourOfReceipts("2026-01-01T10:20:00.000Z", 3);
    const v2 = await verifyReceiptOffline(other.receipts[0]!, { hourEpoch: other.hour, proof: proofFor(other.tree, 0), root: other.tree.root }, { signers: [{ address: other.signer.address as Hex }], anchor });
    expect(v2.checks.onChainRoot).toBe(false);
    expect(v2.valid).toBe(false);

    // an hour not anchored yet: not_posted (signature, leaf and proof still checked)
    const later = await hourOfReceipts("2026-01-01T12:05:00.000Z", 2);
    // within its hour that is pending, never valid (security r1 F1); hours later, or at or below latestHour, it is invalid
    const v3 = await verifyReceiptOffline(later.receipts[1]!, { hourEpoch: later.hour, proof: proofFor(later.tree, 1), root: later.tree.root }, { signers: [{ address: later.signer.address as Hex }], anchor, nowMs: Date.parse("2026-01-01T12:30:00.000Z") });
    expect(v3.checks.onChainRoot).toBe("not_posted");
    expect(v3.valid).toBe(false);
    expect(v3.status).toBe("pending");
    expect(await anchor.latestHour!()).toBe(h.hour);
    const skipped = await hourOfReceipts("2026-01-01T09:05:00.000Z", 1); // below latestHour, never anchored
    const v4 = await verifyReceiptOffline(skipped.receipts[0]!, { hourEpoch: skipped.hour, proof: proofFor(skipped.tree, 0), root: skipped.tree.root }, { signers: [{ address: skipped.signer.address as Hex }], anchor, nowMs: Date.parse("2026-01-01T10:30:00.000Z") });
    expect(v4.checks.onChainRoot).toBe("unanchored");
    expect(v4.status).toBe("invalid");

    // an RPC that serves another chain is refused before any answer is trusted
    const wrongChain = rpcAnchorReader({ rpcUrl: RPC, address, chainId: 4663 });
    expect(((await wrongChain.rootOf(h.hour).catch((x) => x)) as SdkError).code).toBe("DEPLOYMENT_MISMATCH");
  }, 60_000);
});
