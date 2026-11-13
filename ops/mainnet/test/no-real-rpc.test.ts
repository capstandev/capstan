// todo 47 R4: the dry run writes only to the local fork. dry-run.sh refuses any RPC URL that is not the loopback
// anvil or the cache proxy (before it starts anything), and the TS steps refuse to make a client for one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDryRunRpc, localRpc, ROOT } from "../lib";

const SH = join(ROOT, "ops/mainnet/dry-run.sh");
const run = (a: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(["/bin/bash", SH, ...a], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: `${p.stdout}${p.stderr}` };
};
const REAL = ["https://rpc.mainnet.chain.robinhood.com", "https://mainnet.base.org", "http://10.0.0.5:22545", "http://127.0.0.1:8545", "http://127.0.0.1:22545/extra", "https://127.0.0.1:22545", "http://user:pw@127.0.0.1:22545", ""];

describe("dry run is fork only", () => {
  test("fork-only", () => {
    for (const u of ["http://127.0.0.1:22545", "http://127.0.0.1:22546", "http://localhost:22545"]) {
      expect(run(["--check-rpc", u]).code).toBe(0);
      expect(isDryRunRpc(u)).toBe(true);
    }
    for (const u of REAL) {
      const r = run(["--check-rpc", u]);
      expect(r.code).toBe(3);
      expect(r.out).toContain("refuse");
      expect(isDryRunRpc(u)).toBe(false);
      if (u) expect(() => localRpc(u)).toThrow(/refuse/);
    }
    // an RPC_URL in the environment that is not the fork stops the run before any process starts
    const r = run([], { RPC_URL: "https://rpc.mainnet.chain.robinhood.com" });
    expect(r.code).toBe(3);
    expect(r.out).toContain("refuse: RPC_URL");
    expect(r.out).not.toContain("step 1");
  });

  test("the script sends only to the fork: every cast send and the deploy use the loopback RPC", () => {
    const s = readFileSync(SH, "utf8");
    expect(s).toContain('RPC="http://127.0.0.1:$P_ANVIL"');
    const sends = s.split("\n").filter((x) => /CAST" send|fork-steps\.ts" (safe|settle)/.test(x) && !x.trim().startsWith("#"));
    expect(sends.length).toBe(5); // two Safe paths (fresh owners or SAFE_OWNERS), two poster paths (keystore or given), the settle loop
    for (const l of sends) expect(l).toMatch(/--rpc-url "\$RPC"|--rpc "\$RPC"/);
    const deploy = s.match(/\ndeploy\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(deploy).toContain('RPC_URL="$RPC"');
    expect(deploy).toContain('/usr/bin/env -i');
    expect(deploy).toContain('deploy-rhc.sh" mainnet');
    // the upstream is reached only through rpc-cache, which refuses every write method
    expect(s).toMatch(/rpc-cache\.ts" --port "\$P_CACHE" --upstream "\$UPSTREAM"/);
    expect(s).toMatch(/--fork-url "\$CACHE"/);
  });
});
