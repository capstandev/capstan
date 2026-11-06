// S1: DeployAll (CPST -> CPSTLock -> CapstanReceiptAnchor) on the 4663 fork from a fresh deployer keystore, with a
// real Safe 1.4.1 (2 of 3 fresh owners) as the brand Safe, then PostDeployCheck and check-deployments. The record goes
// to contracts/deployments/local/4663-fork.json (a previous fork record is archived first, so DeployAll deploys a
// new set); the committed 4663.json is never written. Then the apps restart with the new addresses.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, CAST, chainTime, FORGE, FORK_FILE, FORK_FILE_REL, makeSafe, PORTS, RHC, rhc, ROOT, run, runKeystore, setBalance, STATE, stateAddr, type Row } from "../lib";
import type { Ctx } from "../every-tx";

export interface Deployed {
  cpst: `0x${string}`;
  lock: `0x${string}`;
  anchor: `0x${string}`;
  poster: `0x${string}`;
  deployer: `0x${string}`;
  file: string;
}

const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent");

export async function s1(ctx: Ctx): Promise<Row[]> {
  const real = join(ROOT, "contracts/deployments/4663.json");
  const realBefore = sha(real);
  if (existsSync(FORK_FILE)) renameSync(FORK_FILE, FORK_FILE.replace(/\.json$/, `.${Date.now()}.json`).replace("4663-fork.", "archived-4663-fork."));
  const ks = runKeystore(join(ctx.dir, "keys"), "deployer");
  await setBalance(ks.address);
  ctx.safe = await makeSafe(ctx.operator);
  const poster = stateAddr("poster");
  // the service keys get a small float, the size the runbooks budget (anchor poster 0.05 ETH, facilitator 0.05 ETH)
  await setBalance(poster, 5n * 10n ** 16n);
  await setBalance(stateAddr("facilitator"), 5n * 10n ** 16n);
  await setBalance(stateAddr("facilitator"), 5n * 10n ** 16n, BASE);
  const day = new Date((await chainTime()) * 1000).toISOString().slice(0, 10);
  const env = { CAPSTAN_DEPLOY_ARMED: "1", EXPECTED_CHAIN_ID: "4663", CAPSTAN_MAINNET_GO: `go-${day}`, POSTER_ADDRESS: poster, BRAND_SAFE: ctx.safe.address, DEPLOYMENTS_FILE: FORK_FILE_REL };
  const out = run([FORGE, "script", "script/DeployAll.s.sol:DeployAll", "--rpc-url", RHC, "--broadcast", "--keystore", ks.path, "--password-file", ks.passwordFile, "--slow"], { cwd: join(ROOT, "contracts"), env });
  writeFileSync(join(ctx.dir, "deploy.log"), out);
  const rec = JSON.parse(readFileSync(FORK_FILE, "utf8")) as { chainId: number; contracts: Record<string, { address: `0x${string}`; block: number }> };
  if (rec.chainId !== 4663) throw new Error(`fork record chain ${rec.chainId}`);
  const broadcast = JSON.parse(readFileSync(join(ROOT, "contracts/broadcast/DeployAll.s.sol/4663/run-latest.json"), "utf8")) as { receipts: { transactionHash: string; gasUsed: string; contractAddress: string | null; status: string }[] };
  const d: Deployed = { cpst: rec.contracts.CPST!.address, lock: rec.contracts.CPSTLock!.address, anchor: rec.contracts.CapstanReceiptAnchor!.address, poster, deployer: ks.address, file: FORK_FILE };
  ctx.deployed = d;
  const rows: Row[] = [];
  for (const [name, addr] of [["CPST", d.cpst], ["CPSTLock", d.lock], ["CapstanReceiptAnchor", d.anchor]] as const) {
    const r = broadcast.receipts.find((x) => x.contractAddress?.toLowerCase() === addr.toLowerCase());
    const code = await rhc.getCode({ address: addr });
    rows.push({ id: "S1", scenario: `deploy ${name}`, ref: r?.transactionHash ?? "-", gas: r ? String(BigInt(r.gasUsed)) : "-", result: r && Number(r.status) === 1 && code && code.length > 2 ? "pass" : "fail", receipt: addr, check: `code ${(code?.length ?? 2) / 2 - 1} bytes` });
    ctx.gas[`deploy ${name}`] = r ? BigInt(r.gasUsed) : 0n;
  }
  // the record's block is the chain's own (L2) block, where a log scan for the contract must start
  const head = Number(await rhc.getBlockNumber());
  const recBlock = rec.contracts.CapstanReceiptAnchor!.block;
  rows.push({ id: "S1", scenario: "deployment record block is the L2 block (log scans start there)", ref: "read-only", gas: "-", result: Math.abs(head - recBlock) < 1_000 ? "pass" : "fail", receipt: "-", check: `record ${recBlock}, head ${head}` });
  // PostDeployCheck (read-only) against the fork record, the real Safe check included
  const pdc = run([FORGE, "script", "script/PostDeployCheck.s.sol:PostDeployCheck", "--rpc-url", RHC], { cwd: join(ROOT, "contracts"), env: { DEPLOYMENTS_FILE: FORK_FILE_REL, BRAND_SAFE: ctx.safe.address, EXPECTED_CHAIN_ID: "4663" } });
  const pdcOk = pdc.includes("post-deploy-check: ok") && pdc.includes("ok: CPST");
  rows.push({ id: "S1", scenario: "PostDeployCheck (code = fresh build, selectors, poster, token, CPST supply, real Safe 1.4.1)", ref: "read-only", gas: "-", result: pdcOk ? "pass" : "fail", receipt: "-", check: pdcOk ? "post-deploy-check: ok" : pdc.split("\n").slice(-5).join(" ") });
  // the committed copies still agree (the fork record is not one of them) and 4663.json is untouched
  const cd = run(["bun", "ops/ci/check-deployments.ts"]);
  const realAfter = sha(real);
  rows.push({ id: "S1", scenario: "check-deployments; committed 4663.json untouched", ref: "read-only", gas: "-", result: realBefore === realAfter ? "pass" : "fail", receipt: "-", check: `${cd.trim().split("\n").pop()}; 4663.json ${realAfter === "absent" ? "absent (not deployed)" : "unchanged"}` });
  // restart the apps on the new addresses; the fork record reaches every role through CAPSTAN_FORK_DEPLOYMENTS
  const depEnv: Record<string, string> = { CAPSTAN_FORK_DEPLOYMENTS: FORK_FILE, ANCHOR_ADDRESS: d.anchor, CPST_LOCK_ADDRESS: d.lock, CPST_ADDRESS: d.cpst, BRAND_SAFE: ctx.safe.address };
  writeFileSync(join(STATE, "deploy.env"), `${Object.entries(depEnv).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  // this process runs jobs in-process too (S3 anchor): it sees the same record the apps do
  Object.assign(process.env, depEnv);
  const { applyForkDeployments } = await import("@capstan/core");
  applyForkDeployments(process.env);
  await ctx.resetAnchorHistory();
  run(["/bin/bash", "ops/fork/up.sh", "apps"]);
  const v = await fetch(`http://127.0.0.1:${PORTS.api}/v1/health`).then((r) => r.status);
  rows.push({ id: "S1", scenario: "apps restarted on the fork record", ref: "GET /v1/health", gas: "-", result: v === 200 ? "pass" : "fail", receipt: "-", check: `api ${v}` });
  void CAST;
  return rows;
}
