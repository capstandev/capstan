// Testnet runner (todo 41): runs every testnet-gated suite in dependency order with the right env, skips a suite whose
// wallets are not funded (with the BACKLOG item in the reason), and appends a "Run N" section to
// docs/reports/testnet-run-<date>.md (TESTNET_REPORT_DIR overrides). A second run the same day skips contracts that
// are already deployed (deploy-rhc.sh reads the deployment file and checks code) and reuses every wallet.
// Network rule: testnets only. Every sender asserts its network first (guard.ts, deploy-rhc.sh stage 1, make-safe.sh,
// the suites' own asserts). No key or password is ever printed: suite output is scanned and only counts are kept.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runReadCanary } from "../../apps/workers/src/jobs/canary-read.job";
import { runSignedCanary } from "../../apps/workers/src/jobs/canary-signed.job";
import { runDoctor, RPC, type DoctorReport } from "./doctor";
import { FAUCETS, solanaAirdrop } from "./faucet";
import { findSecrets } from "./guard";
import { keystorePath, passwordPath, paths, WALLETS, type Paths } from "./wallets";

export const ROOT = resolve(import.meta.dir, "../..");

export interface Row {
  suite: string;
  rule: string;
  result: "pass" | "fail" | "skip" | "waiting";
  detail: string;
}

export interface ExecResult {
  code: number;
  out: string;
}
export type Exec = (cmd: string[], env: Record<string, string>) => Promise<ExecResult>;

const realExec: Exec = async (cmd, env) => {
  const p = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: `${o}\n${e}` };
};

export interface RunOptions {
  env?: Record<string, string | undefined>;
  exec?: Exec;
  doctor?: () => Promise<DoctorReport>;
  airdrop?: typeof solanaAirdrop;
  canaries?: boolean;
  reportDir?: string;
  now?: () => Date;
}

const BUN = existsSync(join(process.env.HOME ?? "", ".bun/bin/bun")) ? join(process.env.HOME!, ".bun/bin/bun") : "/opt/homebrew/bin/bun";

/** bun test summary -> counts. */
export function testCounts(out: string): { pass: number; fail: number; skip: number } {
  const n = (re: RegExp) => Number(out.match(re)?.[1] ?? 0);
  return { pass: n(/^\s*(\d+) pass/m), fail: n(/^\s*(\d+) fail/m), skip: n(/^\s*(\d+) skip/m) };
}

export async function runAll(o: RunOptions = {}): Promise<{ rows: Row[]; report: string; run: number }> {
  const env = o.env ?? process.env;
  const p: Paths = paths(env);
  const exec = o.exec ?? realExec;
  const now = o.now ?? (() => new Date());
  const started = now();
  let doc = await (o.doctor ?? (() => runDoctor({ env })))();
  const rows: Row[] = [];
  const secrets = WALLETS.map((w) => passwordPath(w, p)).filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8"));
  const ks = (role: string) => keystorePath(WALLETS.find((w) => w.role === role)!, p);
  const pw = (role: string) => passwordPath({ role }, p);
  const addr = (role: string) => doc.addresses[role] ?? "";
  const funded = (...roles: string[]) => roles.every((r) => doc.funded[r]);
  const missing = (...roles: string[]) => {
    const items = new Set(doc.rows.filter((x) => roles.includes(x.role) && !x.ok).map((x) => x.backlog));
    return `waiting on ${[...items].sort().join(", ") || "make-wallets.sh"} (${roles.filter((r) => !doc.funded[r]).join(", ")} not funded)`;
  };
  const safe = (text: string) => (findSecrets(text, secrets).length ? "[output withheld: the secret scan flagged it]" : text);
  const suite = async (name: string, rule: string, files: string[], e: Record<string, string>) => {
    const r = await exec([BUN, "test", "--timeout", "30000", ...files], e);
    const c = testCounts(r.out);
    const lastFail = r.code !== 0 ? safe((r.out.match(/^.*(error|fail).*$/gim) ?? []).slice(-2).join(" | ").slice(0, 300)) : "";
    rows.push({ suite: name, rule, result: r.code === 0 && c.fail === 0 ? (c.pass > 0 ? "pass" : "skip") : "fail", detail: `${c.pass} pass, ${c.fail} fail, ${c.skip} skip${lastFail ? `; ${lastFail}` : ""}` });
  };

  // 1. keyless faucet: Solana devnet SOL for the fee payer (the only faucet with a public API and no sign-in)
  const solRow = doc.rows.find((x) => x.role === "sol-facilitator" && x.asset === "SOL");
  if (solRow?.address && !solRow.ok) {
    const a = await (o.airdrop ?? solanaAirdrop)(solRow.address, 1);
    rows.push({ suite: "faucet: Solana devnet airdrop", rule: "A6", result: a.error ? "waiting" : "pass", detail: a.error ? `devnet airdrop refused (${safe(a.error)}); waiting on A6 (https://faucet.solana.com)` : `1 SOL to sol-facilitator, signature ${a.signature}` });
    if (!a.error) doc = await (o.doctor ?? (() => runDoctor({ env })))();
  } else rows.push({ suite: "faucet: Solana devnet airdrop", rule: "A6", result: "skip", detail: solRow?.ok ? "sol-facilitator already funded" : "wallet not made" });

  // 2. RHC testnet contracts: brand Safe, then CPST, CPSTLock, CapstanReceiptAnchor (R3)
  if (funded("deployer")) {
    const s = await exec(["/bin/bash", "ops/testnet/make-safe.sh"], {});
    rows.push({ suite: "rhc: testnet brand Safe", rule: "R3", result: s.code === 0 ? "pass" : "fail", detail: safe(s.out.trim().split("\n").slice(-1)[0] ?? "") });
    const safeFile = join(p.home, "brand-safe.json");
    if (s.code === 0 && existsSync(safeFile)) {
      const brand = (JSON.parse(readFileSync(safeFile, "utf8")) as { address: string }).address;
      const d = await exec(["/bin/bash", "ops/deploy/deploy-rhc.sh", "testnet"], { DEPLOYER_KEYSTORE: ks("deployer"), DEPLOYER_PASSWORD_FILE: pw("deployer"), POSTER_ADDRESS: addr("anchor-poster"), BRAND_SAFE: brand });
      const lines = d.out.trim().split("\n");
      const skipped = lines.filter((l) => l.startsWith("skip: already deployed")).length;
      rows.push({ suite: "rhc: deploy (deploy-rhc.sh testnet)", rule: "R3, R10", result: lines.some((l) => l.startsWith("stage 4: deploy failed") || l.startsWith("stage 2: refuse") || l.startsWith("stage 1: refuse")) ? "fail" : "pass", detail: skipped === 3 ? "skipped: all three contracts already deployed (deployment file + code check)" : safe(lines.find((l) => l.startsWith("stage 4")) ?? "") });
      const sourcify = lines.find((l) => l.includes("Sourcify recorded") || l.includes("Sourcify NOT verified") || l.includes("Sourcify already")) ?? "no Sourcify line";
      rows.push({ suite: "rhc: Sourcify", rule: "R3", result: /NOT verified/.test(sourcify) ? "fail" : "pass", detail: safe(sourcify) });
      const pdc = lines.find((l) => l.startsWith("stage 6")) ?? "post-deploy check did not run";
      rows.push({ suite: "rhc: PostDeployCheck", rule: "R3", result: /ok/.test(pdc) ? "pass" : "fail", detail: safe(pdc) });
    }
  } else rows.push({ suite: "rhc: Safe + deploy + Sourcify + PostDeployCheck", rule: "R3, R10", result: "waiting", detail: missing("deployer") });
  rows.push({ suite: "rhc: anchor posts hourly for 3 hours", rule: "R3", result: "waiting", detail: funded("deployer", "anchor-poster") ? "run the workers with CAPSTAN_NETWORK=testnet and the poster keystore for 3 hours (runbook testnet-wallets.md)" : missing("deployer", "anchor-poster") });

  // 3. Hyperliquid testnet (R4)
  const hlEnv = { HL_TESTNET_KEYSTORE: ks("hl-main"), HL_TESTNET_PASSWORD_FILE: pw("hl-main"), HL_TESTNET_BUILDER: addr("hl-builder"), HL_NETWORK: "Testnet" };
  if (funded("hl-main", "hl-builder")) await suite("hyperliquid testnet: onboard, order, HIP-3", "R4", ["packages/adapters/hyperliquid/test/testnet"], hlEnv);
  else rows.push({ suite: "hyperliquid testnet: onboard, order, HIP-3", rule: "R4", result: "waiting", detail: missing("hl-main", "hl-builder") });

  // 4. Lighter 300, both testnets (R5)
  const idx = (role: string) => String(doc.rows.find((x) => x.role === role)?.detail?.accountIndex ?? "");
  if (funded("lighter")) await suite("lighter testnet (signing id 300)", "R5", ["packages/adapters/lighter/test/testnet/lighter.test.ts"], { LIGHTER_TESTNET_KEYSTORE: ks("lighter"), LIGHTER_TESTNET_ACCOUNT_INDEX: idx("lighter") });
  else rows.push({ suite: "lighter testnet (signing id 300)", rule: "R5", result: "waiting", detail: missing("lighter") });
  if (funded("lighter-rh")) await suite("lighter RH testnet (separate account)", "R5", ["packages/adapters/lighter/test/testnet/rh.test.ts"], { LIGHTER_RH_TESTNET_KEYSTORE: ks("lighter-rh"), LIGHTER_RH_TESTNET_ACCOUNT_INDEX: idx("lighter-rh") });
  else rows.push({ suite: "lighter RH testnet (separate account)", rule: "R5", result: "waiting", detail: missing("lighter-rh") });

  // 5. Aster testnet: VPS only (R6)
  rows.push({ suite: "aster testnet (VPS)", rule: "R6", result: env.CAPSTAN_RUNNER === "vps" ? "waiting" : "skip", detail: env.CAPSTAN_RUNNER === "vps" ? "run `bun test packages/adapters/aster/test/vps` on the VPS with the make-wallets-vps.sh keystores" : "VPS only: Aster's terms list Canada (waiting on D1 and A4)" });

  // 6. x402 settlements (R7)
  if (funded("facilitator", "x402-payer"))
    await suite("x402: Base Sepolia USDC + RHC testnet USDG", "R7", ["packages/x402/test/testnet/settle.test.ts"], {
      FACILITATOR_TESTNET_KEYSTORE: ks("facilitator"),
      FACILITATOR_TESTNET_PASSWORD_FILE: pw("facilitator"),
      X402_TESTNET_PAYER_KEYSTORE: ks("x402-payer"),
      X402_TESTNET_PAYER_PASSWORD_FILE: pw("x402-payer"),
      X402_TESTNET_PAYTO: addr("x402-payto"),
      RHC_TESTNET_RPC_URL: RPC.rhc,
      BASE_SEPOLIA_RPC_URL: RPC.baseSepolia,
    });
  else rows.push({ suite: "x402: Base Sepolia USDC + RHC testnet USDG", rule: "R7", result: "waiting", detail: missing("facilitator", "x402-payer") });
  if (funded("sol-facilitator", "sol-payer"))
    await suite("x402: Solana devnet USDC", "R7", ["packages/x402/test/testnet/svm-devnet.test.ts"], {
      SOLANA_DEVNET_PAYER: ks("sol-payer"),
      SOLANA_DEVNET_PAYER_PASSWORD_FILE: pw("sol-payer"),
      FACILITATOR_SOL_KEYPAIR: ks("sol-facilitator"),
      FACILITATOR_SOL_PASSWORD_FILE: pw("sol-facilitator"),
      X402_TESTNET_PAYTO_SOL: addr("sol-payto"),
      SOLANA_DEVNET_RPC_URL: RPC.solanaDevnet,
    });
  else rows.push({ suite: "x402: Solana devnet USDC", rule: "R7", result: "waiting", detail: missing("sol-facilitator", "sol-payer") });

  // 7. paired spread with a forced leg B failure (R8)
  if (funded("hl-main", "lighter")) await suite("spread pair HL + Lighter 300 (leg B forced to fail)", "R8", ["packages/spreads/test/testnet/pair.test.ts"], { ...hlEnv, LIGHTER_TESTNET_KEYSTORE: ks("lighter") });
  else rows.push({ suite: "spread pair HL + Lighter 300 (leg B forced to fail)", rule: "R8", result: "waiting", detail: missing("hl-main", "lighter") });

  // 8. canaries (R9): one read canary pass on the testnet profile, one signed canary pass
  if (o.canaries !== false) {
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
    const reads = await runReadCanary({ log: quiet }, { env: { CAPSTAN_NETWORK: "testnet" } });
    const bad = reads.filter((r) => !r.ok);
    rows.push({ suite: "canary: read (testnet hosts)", rule: "R9", result: bad.length ? "fail" : "pass", detail: bad.length ? safe(bad.map((r) => `${r.venue} ${r.kind}: ${r.error}`).join("; ")) : `${reads.length}/${reads.length} reads ok (HL, Lighter, Lighter-RH, Aster: health, book, funding)` });
    const signed = await runSignedCanary({ log: quiet }, { env: { CAPSTAN_NETWORK: "testnet", ...(funded("hl-main") ? { HL_TESTNET_KEYSTORE: ks("hl-main"), HL_TESTNET_PASSWORD_FILE: pw("hl-main") } : {}) } });
    for (const s of signed) rows.push({ suite: `canary: signed ${s.venue}`, rule: "R9", result: s.status === "ok" ? "pass" : s.status === "failed" ? "fail" : "waiting", detail: safe(s.detail) });
  }

  const report = await writeReport(o.reportDir ?? env.TESTNET_REPORT_DIR ?? join(ROOT, "../docs/reports"), started, rows, doc, secrets);
  return { rows, report: report.file, run: report.run };
}

async function writeReport(dir: string, at: Date, rows: Row[], doc: DoctorReport, secrets: string[]): Promise<{ file: string; run: number }> {
  const day = at.toISOString().slice(0, 10);
  const file = resolve(dir, `testnet-run-${day}.md`);
  const f = Bun.file(file);
  const prev = (await f.exists()) ? await f.text() : "";
  const run = (prev.match(/^## Run \d+/gm)?.length ?? 0) + 1;
  const head = prev
    ? prev
    : [
        `# Testnet run ${day}`,
        "",
        "Written by `ops/testnet/run-all.sh` (todo 41). Each run appends a section. Testnets only: RHC 46630, Base Sepolia 84532,",
        "Solana devnet, Hyperliquid testnet, Lighter signing id 300, Aster testnet from the VPS. Addresses are public; no key or",
        "password appears here (the runner scans every line it keeps). A suite whose wallets are unfunded is listed as waiting,",
        "with the BACKLOG item.",
        "",
        "## Faucets checked",
        "",
        "| Faucet | URL | Usable by the runner | Why |",
        "|---|---|---|---|",
        ...FAUCETS.map((x) => `| ${x.faucet} | ${x.url} | ${x.usable ? "yes" : "no"} | ${x.why} |`),
        "",
      ].join("\n");
  const count = (r: Row["result"]) => rows.filter((x) => x.result === r).length;
  const section = [
    `## Run ${run} (${at.toISOString()})`,
    "",
    `Summary: ${count("pass")} pass, ${count("fail")} fail, ${count("waiting")} waiting, ${count("skip")} skipped.`,
    "",
    "| Wallet | Address | Network | Balance | State |",
    "|---|---|---|---|---|",
    ...doc.rows.map((x) => `| ${x.role} | ${x.address ?? "-"} | ${x.network} | ${x.balance === null ? "n/a" : `${x.balance} ${x.asset}`} | ${x.ok ? "funded" : `${x.missing} (BACKLOG ${x.backlog})`} |`),
    "",
    "| Suite | Rule | Result | Detail |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.suite} | ${r.rule} | ${r.result} | ${r.detail.replace(/\|/g, "/")} |`),
    "",
  ].join("\n");
  const text = `${head.trimEnd()}\n\n${section}`;
  const problems = findSecrets(text, secrets);
  if (problems.length) throw new Error(`report not written: the secret scan flagged it (${problems.length} problems)`);
  await Bun.write(file, text);
  return { file, run };
}

if (import.meta.main) {
  const r = await runAll();
  for (const x of r.rows) console.log(`${x.result.padEnd(7)} ${x.suite} (${x.rule}): ${x.detail}`);
  console.log(`run ${r.run}: report ${r.report}`);
  process.exit(r.rows.some((x) => x.result === "fail") ? 1 : 0);
}
