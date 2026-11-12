// Release gate 2026-11-08, fork S3 and S13: /verify read onChainRoot "not_posted" while the SDK read the posted root.
// On a fork the anchor comes from the throwaway fork record (CAPSTAN_FORK_DEPLOYMENTS, applied to DEPLOYMENTS), but an
// empty chain answer was kept for 30 s, so a root posted seconds after a first /verify still read not_posted, and a
// root the fork reverted and posted again stayed cached for good. A fork record's reader now reads the chain on every
// check; a real host keeps the cache, and the mainnet rule (the address
// comes only from DEPLOYMENTS, never from ANCHOR_ADDRESS) is unchanged.
import { afterAll, describe, expect, test } from "bun:test";
import { applyForkDeployments } from "@capstan/core";
import { DEPLOYMENTS, type Hex } from "@capstan/schema";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorReaderFromEnv, receiptDepsWith } from "../src/routes/receipts.routes";

const ANCHOR = "0x00000000000000000000000000000000000a1c41" as Hex;
const ROOT = `0x${"ab".repeat(32)}` as Hex;
const dir = mkdtempSync(join(tmpdir(), "capstan-gate-fork-anchor-"));
const had4663 = 4663 in DEPLOYMENTS;
afterAll(() => {
  if (!had4663) delete DEPLOYMENTS[4663];
  rmSync(dir, { recursive: true, force: true });
});

/** A chain that has not posted the hour yet on the first read and has posted it from the second read on. */
const postedAfterFirst = () => {
  let reads = 0;
  return { reads: () => reads, readRoot: async () => (reads++ === 0 ? null : ROOT), latestHour: async () => 0 };
};

describe("gate fork anchor for /verify", () => {
  test("mainnet rule: ANCHOR_ADDRESS alone never names the anchor", async () => {
    expect(had4663).toBe(false); // 4663 is not deployed: nothing committed for this test to shadow
    expect(await anchorReaderFromEnv({ CAPSTAN_NETWORK: "mainnet", ANCHOR_ADDRESS: ANCHOR, ANCHOR_RPC_URL: "http://127.0.0.1:24690" })).toBeNull();
  });

  test("fork record: the reader is found and marked fork", async () => {
    const file = join(dir, "4663-fork.json");
    writeFileSync(file, JSON.stringify({ chainId: 4663, contracts: { CapstanReceiptAnchor: { address: ANCHOR, block: 1 } } }));
    const env = { CAPSTAN_NETWORK: "mainnet", CAPSTAN_FORK_DEPLOYMENTS: file, RHC_RPC_URL: "http://127.0.0.1:24690", ANCHOR_RPC_URL: "http://127.0.0.1:24690" };
    expect(applyForkDeployments(env)).toBe(4663);
    const r = await anchorReaderFromEnv(env);
    expect(r).not.toBeNull();
    expect(r?.fork).toBe(true);
  });

  test("d1-fork-01: a fork record with ANCHOR_RPC_URL unset never reads the public RPC", async () => {
    const file = join(dir, "4663-fork.json");
    writeFileSync(file, JSON.stringify({ chainId: 4663, contracts: { CapstanReceiptAnchor: { address: ANCHOR, block: 1 } } }));
    // the loader passes: no chain RPC is set, so none is remote
    expect(applyForkDeployments({ CAPSTAN_FORK_DEPLOYMENTS: file })).toBe(4663);
    expect(await anchorReaderFromEnv({ CAPSTAN_NETWORK: "mainnet" })).toBeNull();
    expect(await anchorReaderFromEnv({ CAPSTAN_NETWORK: "mainnet", ANCHOR_RPC_URL: "https://rpc.example.org" })).toBeNull();
    expect((await anchorReaderFromEnv({ CAPSTAN_NETWORK: "mainnet", ANCHOR_RPC_URL: "http://127.0.0.1:24690" }))?.fork).toBe(true);
  });

  test("fork reader: a root posted after the first check is seen at once", async () => {
    const chain = postedAfterFirst();
    const deps = receiptDepsWith({} as never, [], { fork: true, readRoot: chain.readRoot, latestHour: chain.latestHour });
    expect(await deps.readRoot!(100)).toBeNull();
    expect(await deps.readRoot!(100)).toBe(ROOT);
  });

  test("fork reader: a root the fork reverted and posted again is read again", async () => {
    let root: Hex = ROOT;
    const deps = receiptDepsWith({} as never, [], { fork: true, readRoot: async () => root, latestHour: async () => 0 });
    expect(await deps.readRoot!(100)).toBe(ROOT);
    root = `0x${"cd".repeat(32)}` as Hex; // snapshot reverted, the hour posted again with more leaves
    expect(await deps.readRoot!(100)).toBe(root);
  });

  test("real host: an empty answer is still cached (no extra chain reads)", async () => {
    const chain = postedAfterFirst();
    const deps = receiptDepsWith({} as never, [], { fork: false, readRoot: chain.readRoot, latestHour: chain.latestHour });
    expect(await deps.readRoot!(100)).toBeNull();
    expect(await deps.readRoot!(100)).toBeNull();
    expect(chain.reads()).toBe(1);
  });
});
