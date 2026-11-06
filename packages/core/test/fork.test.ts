// ops/fork: a fork stack adds its throwaway `<chainId>-fork.json` record to DEPLOYMENTS at boot, only with every chain
// RPC on loopback, and never over a committed record.
import { describe, expect, test } from "bun:test";
import type { Deployment } from "@capstan/schema";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyForkDeployments, ForkDeploymentError } from "../src/fork";

const A = "0x00000000000000000000000000000000000000a1"; // not-a-key
const rec = (chainId: number): Deployment => ({ chainId, contracts: { CapstanReceiptAnchor: { address: A, block: 1, poster: A } }, deployer: A, sourcify: { verified: false }, updatedAt: "2026-11-06T00:00:00Z" });

function file(name: string, body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "fork-dep-"));
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe("fork deployments", () => {
  test("fork-record-added", () => {
    const into: Record<number, Deployment> = {};
    const p = file("4663-fork.json", rec(4663));
    expect(applyForkDeployments({}, into)).toBeNull();
    expect(applyForkDeployments({ CAPSTAN_FORK_DEPLOYMENTS: p, RHC_RPC_URL: "http://127.0.0.1:22445", BASE_RPC_URL: "http://localhost:22447" }, into)).toBe(4663);
    expect(into[4663]?.contracts.CapstanReceiptAnchor?.address).toBe(A);
    // a rerun with a second fork set replaces the first fork record
    expect(applyForkDeployments({ CAPSTAN_FORK_DEPLOYMENTS: p, RHC_RPC_URL: "http://127.0.0.1:22445" }, into)).toBe(4663);
  });

  test("refuses-unsafe-input", () => {
    const ok = file("4663-fork.json", rec(4663));
    const cases: [Record<string, string>, Record<number, Deployment>, RegExp][] = [
      [{ CAPSTAN_FORK_DEPLOYMENTS: file("4663.json", rec(4663)) }, {}, /<chainId>-fork.json/],
      [{ CAPSTAN_FORK_DEPLOYMENTS: ok, RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com" }, {}, /not loopback: RHC_RPC_URL/],
      [{ CAPSTAN_FORK_DEPLOYMENTS: ok, ANCHOR_RPC_URL: "http://10.1.1.1:8545" }, {}, /ANCHOR_RPC_URL/],
      [{ CAPSTAN_FORK_DEPLOYMENTS: file("46630-fork.json", rec(4663)) }, {}, /chainId differs/],
      [{ CAPSTAN_FORK_DEPLOYMENTS: ok }, { 4663: rec(4663) }, /committed deployment/],
    ];
    for (const [env, into, re] of cases) {
      expect(() => applyForkDeployments(env, into)).toThrow(ForkDeploymentError);
      expect(() => applyForkDeployments(env, into)).toThrow(re);
    }
  });
});
