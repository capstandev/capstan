// Security review r2, D2-ADP-06 (review-r1:7 F6, review-r1:8 R1-8-02): services on one VPS labelled the same egress IP
// differently (the relay vps-1, the api 'local', risk-ingest the IP string, workers CAPSTAN_EGRESS_ID or 'local'), so
// each label got its own 80% of one IP's venue budgets. Every service now resolves one label from one key, the server
// env files set the same one in api, relay and workers, and mainnet refuses to boot without it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { egressIdOf } from "@capstan/venue-client";
import { egressLabel } from "@capstan/adapter-aster";
import { loadConfig } from "@capstan/core";

const ETC = join(import.meta.dir, "../../../../ops/server/etc");
const envOf = (svc: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(join(ETC, `${svc}.env`), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

describe("security r2 D2-ADP-06", () => {
  test("server-env-files-resolve-one-egress-label", () => {
    const labels = ["api", "relay", "workers", "anchor", "receipts"].map((s) => egressIdOf(envOf(s)));
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).not.toBe("local");
    // the Aster reader and risk-ingest label is the same one, not the IP string
    for (const s of ["api", "relay", "workers"]) expect(egressLabel(envOf(s))).toBe(labels[0]!);
  });

  test("mainnet-needs-the-egress-label", () => {
    const base = { CAPSTAN_NETWORK: "mainnet", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/d", REDIS_URL: "redis://127.0.0.1:6379", RECEIPT_SIGNER: "none" };
    expect(() => loadConfig("api", base)).toThrow("CAPSTAN_EGRESS_ID");
    expect(() => loadConfig("relay", base)).toThrow("CAPSTAN_EGRESS_ID");
    expect(loadConfig("api", { ...base, CAPSTAN_EGRESS_ID: "vps-1" }).CAPSTAN_EGRESS_ID).toBe("vps-1");
    expect(() => loadConfig("api", { CAPSTAN_NETWORK: "testnet", DATABASE_URL: base.DATABASE_URL, REDIS_URL: base.REDIS_URL })).not.toThrow();
  });
});
