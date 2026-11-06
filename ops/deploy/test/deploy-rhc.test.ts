// deploy-rhc.sh stage 5 (Sourcify): a failed verify is reported as failed, recorded as "verified": false and the run
// exits 1; only forge success AND a Sourcify match for every contract records "verified": true. The script runs
// from a copy in a temp tree with stand-in tools (DEPLOY_TOOL_DIR), so nothing touches a chain or the network.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "deploy-rhc.sh");
const ADDR = {
  CPST: "0x1000000000000000000000000000000000000001",
  CPSTLock: "0x2000000000000000000000000000000000000002",
  CapstanReceiptAnchor: "0x3000000000000000000000000000000000000003",
} as const;
const made: string[] = [];

function sh(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A temp tree: the script copy, a stub post-deploy check and gen-deployments, a testnet deployment file, stand-in tools. */
function tree(): { root: string; tools: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "capstan-deploy-"));
  made.push(root);
  mkdirSync(join(root, "ops/deploy"), { recursive: true });
  mkdirSync(join(root, "ops/ci"), { recursive: true });
  mkdirSync(join(root, "contracts/deployments"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "ops/deploy/deploy-rhc.sh"));
  sh(join(root, "ops/deploy/post-deploy-check.sh"), 'echo "stage 6: post-deploy check ok (stub)"');
  writeFileSync(join(root, "ops/ci/gen-deployments.ts"), "// stub\n");
  const file = join(root, "contracts/deployments/46630.json");
  const contracts = Object.fromEntries(Object.entries(ADDR).map(([k, a]) => [k, { address: a }]));
  writeFileSync(file, JSON.stringify({ chainId: 46630, contracts, deployer: "0x4000000000000000000000000000000000000004", sourcify: { verified: false } }, null, 2) + "\n");
  const tools = join(root, "tools");
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, "bun"));
  // cast: chain id, gas price, balance, code size, abi-encode and the keystore address (no key is ever read)
  sh(
    join(tools, "cast"),
    `case "$1" in
  chain-id) echo 46630 ;;
  gas-price) echo 1 ;;
  balance) echo 100000000000000000000 ;;
  codesize) echo 100 ;;
  abi-encode) echo 0x00 ;;
  wallet) echo 0x4000000000000000000000000000000000000004 ;;
  *) echo "fake cast: unexpected $*" >&2; exit 9 ;;
esac`,
  );
  // forge: verify-contract fails for the names in FAIL_VERIFY; anything else is unexpected (no deploy stage runs)
  sh(
    join(tools, "forge"),
    `[ "$1" = "verify-contract" ] || { echo "fake forge: unexpected $*" >&2; exit 9; }
name="\${3##*:}"
case " \${FAIL_VERIFY:-} " in *" $name "*) echo "Error: verification failed for $name"; exit 1 ;; esac
echo "Contract successfully verified"`,
  );
  // curl: Sourcify's read API answers a match for the addresses in SOURCIFY_MATCH, else a 404 (curl -f exits 22)
  sh(
    join(tools, "curl"),
    `url="\${@: -1}"; a="\${url##*/}"
case " \${SOURCIFY_MATCH:-} " in *" $a "*) echo '{"match":"exact_match","address":"'"$a"'"}' ;; *) exit 22 ;; esac`,
  );
  return { root, tools, file };
}

function run(t: ReturnType<typeof tree>, env: Record<string, string>): { code: number; out: string } {
  const p = Bun.spawnSync(["/bin/bash", join(t.root, "ops/deploy/deploy-rhc.sh"), "testnet"], {
    env: { PATH: "/usr/bin:/bin", HOME: t.root, DEPLOY_TOOL_DIR: t.tools, SOURCIFY_API: "http://sourcify.invalid", POSTER_ADDRESS: "0x5000000000000000000000000000000000000005", BRAND_SAFE: "0x6000000000000000000000000000000000000006", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

const sourcify = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { sourcify: { verified: boolean; failed?: string[]; url?: string } }).sourcify;
const ALL = Object.values(ADDR).join(" ");

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("deploy-rhc.sh stage 5", () => {
  test("failed-verify-exits-nonzero: a forge verify failure is reported, recorded as not verified, and the run exits 1", () => {
    const t = tree();
    const r = run(t, { FAIL_VERIFY: "CPSTLock", SOURCIFY_MATCH: ALL });
    expect(r.out).toContain("Sourcify verify FAILED for CPSTLock");
    expect(r.out).not.toContain("recorded as verified");
    expect(r.code).toBe(1);
    expect(sourcify(t.file)).toEqual({ verified: false, failed: ["CPSTLock"] });
  });

  test("no-match-is-not-verified: forge exits 0 but Sourcify has no match, so it is a failure", () => {
    const t = tree();
    const r = run(t, { SOURCIFY_MATCH: `${ADDR.CPST} ${ADDR.CPSTLock}` });
    expect(r.out).toContain("Sourcify has no match for " + ADDR.CapstanReceiptAnchor);
    expect(r.code).toBe(1);
    expect(sourcify(t.file).verified).toBe(false);
    expect(sourcify(t.file).failed).toEqual(["CapstanReceiptAnchor"]);
  });

  test("all-verified-records-true: every contract verified and matched records verified true and exits 0; a re-run skips stage 5", () => {
    const t = tree();
    const r = run(t, { SOURCIFY_MATCH: ALL });
    expect(r.out).toContain("stage 5: Sourcify recorded as verified");
    expect(r.code).toBe(0);
    expect(sourcify(t.file)).toEqual({ verified: true, url: `https://repo.sourcify.dev/46630/${ADDR.CapstanReceiptAnchor}` });
    const again = run(t, { FAIL_VERIFY: "CPST CPSTLock CapstanReceiptAnchor" });
    expect(again.out).toContain("skip: stage 5, Sourcify already recorded");
    expect(again.code).toBe(0);
  });

  test("retry-after-failure: a failed run leaves stage 5 open, and a later good run records verified", () => {
    const t = tree();
    expect(run(t, { FAIL_VERIFY: "CPST", SOURCIFY_MATCH: ALL }).code).toBe(1);
    const r = run(t, { SOURCIFY_MATCH: ALL });
    expect(r.code).toBe(0);
    expect(sourcify(t.file).verified).toBe(true);
  });
});
