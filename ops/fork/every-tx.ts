// Every transaction on the fork stack (todo 40). Needs ops/fork/up.sh running. Each scenario S1 to S13 is a group of
// report rows (scenario, tx hash or request id, gas, result, receipt id, check); a failed check is a failed row with
// the error, never a skipped one. Fresh keys every run: in-memory wallets for users and owners, a run keystore for the
// deployer; anvil's default accounts are never used. A second run on the same fork deploys a second contract set
// (the fork record is archived first, never the committed 4663.json). Writes the report to the private docs folder
// next to the repo (FORK_REPORT_DIR overrides) and prints the pass count.
// Usage: bun ops/fork/every-tx.ts [--only S1,S3]
import { closeDb, createDb, createMarketDataCache, createRedis, logger, type Db, type JobDeps } from "@capstan/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PrivateKeyAccount } from "viem/accounts";
import { API, DATABASE_URL, freshWallet, PORTS, REDIS_URL, rhc, ROOT, setBalance, STATE, type ForkSafe, type Row } from "./lib";
import type { Deployed } from "./scenarios/s1-deploy";

export interface Ctx {
  runId: string;
  dir: string;
  operator: PrivateKeyAccount; // pays gas for helper transactions (Safe creation, pool setup)
  safe: ForkSafe;
  deployed: Deployed;
  gas: Record<string, bigint>;
  db: Db;
  jobDeps(now?: () => Date): JobDeps;
  resetAnchorHistory(): Promise<void>;
  shared: Record<string, unknown>;
}

type Scenario = { id: string; name: string; run: (ctx: Ctx) => Promise<Row[]> };

/** The stack env, so in-process job runs read the same settings as the apps. */
function loadStackEnv(): void {
  for (const f of ["stack.env", "deploy.env"]) {
    const p = join(STATE, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) process.env[m[1]!] = m[2]!;
    }
  }
}

async function scenarios(): Promise<Scenario[]> {
  const { s1 } = await import("./scenarios/s1-deploy");
  const m = await import("./scenarios/money");
  const x = await import("./scenarios/x402");
  const c = await import("./scenarios/chain");
  const r = await import("./scenarios/rh");
  const mc = await import("./scenarios/mcp");
  const sp = await import("./scenarios/spread");
  // order: x402 first (it needs the fork clock at real time), clock-moving scenarios (S3 one hour, S2 thirty days)
  // put the clock back when they finish
  return [
    { id: "S1", name: "every-tx::S1-deploy", run: s1 },
    { id: "S5", name: "every-tx::S5-x402-usdg-both", run: x.s5 },
    { id: "S6", name: "every-tx::S6-x402-base", run: x.s6 },
    { id: "S3", name: "every-tx::S3-order-receipt-anchor", run: m.s3 },
    { id: "S4", name: "every-tx::S4-direct-claim", run: m.s4 },
    { id: "S8", name: "every-tx::S8-kill", run: m.s8 },
    { id: "S10", name: "every-tx::S10-geo-refusal", run: m.s10 },
    { id: "S7", name: "every-tx::S7-lighter-rh-deposit", run: r.s7 },
    { id: "S11", name: "every-tx::S11-burn", run: r.s11 },
    { id: "S13", name: "every-tx::S13-mcp-agent", run: mc.s13 },
    { id: "S9", name: "every-tx::S9-spread-flatten", run: sp.s9 },
    { id: "S2", name: "every-tx::S2-lock-tier-unlock", run: c.s2 },
    { id: "S12", name: "every-tx::S12-quote-equals-build-and-gas", run: m.s12 },
  ];
}

export async function main(argv = process.argv.slice(2)): Promise<{ rows: Row[]; passed: number; total: number; report: string }> {
  if (!existsSync(join(STATE, "stack.env"))) throw new Error("start the stack first: bash ops/fork/up.sh");
  loadStackEnv();
  if ((await rhc.getChainId()) !== 4663) throw new Error("the RHC fork must answer chain id 4663");
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const dir = join(STATE, "runs", runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = createDb(DATABASE_URL, { max: 4 });
  const redis = createRedis(REDIS_URL, { forBullmq: true });
  const operator = freshWallet();
  await setBalance(operator.address);
  const ctx: Ctx = {
    runId,
    dir,
    operator,
    safe: null as unknown as ForkSafe,
    deployed: null as unknown as Deployed,
    gas: {},
    db,
    jobDeps: (now = () => new Date()) => ({ db, redis, cache: createMarketDataCache(redis), log: logger("every-tx"), now }),
    async resetAnchorHistory() {
      // a new anchor contract starts with no posted roots: the poster's history for the previous fork set is dropped
      if (!DATABASE_URL.includes(`:${PORTS.pg}/`)) throw new Error("refuse: not the fork database");
      await db.$client`delete from receipt_roots`;
      await db.$client`delete from root_events`;
      await db.$client`delete from chain_cursors`;
    },
    shared: {},
  };
  const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1]!.split(",")) : null;
  const rows: Row[] = [];
  const started = Date.now();
  for (const s of await scenarios()) {
    if (only && !only.has(s.id) && s.id !== "S1") continue;
    const t0 = Date.now();
    try {
      const r = await s.run(ctx);
      rows.push(...r);
      console.log(`${s.id}: ${r.every((x) => x.result === "pass") ? "pass" : "FAIL"} (${r.length} rows, ${Date.now() - t0} ms)`);
      for (const x of r.filter((x) => x.result !== "pass")) console.log(`  fail: ${x.scenario}: ${x.check} ${x.error ?? ""}`);
    } catch (e) {
      const msg = (e as Error).message.split("\n").slice(0, 8).join(" | ");
      rows.push({ id: s.id, scenario: s.name, ref: "-", gas: "-", result: "fail", receipt: "-", check: "threw", error: msg });
      console.log(`${s.id}: FAIL ${msg}`);
    }
  }
  const byId = new Map<string, boolean>();
  for (const r of rows) byId.set(r.id, (byId.get(r.id) ?? true) && r.result === "pass");
  const passed = [...byId.values()].filter(Boolean).length;
  const report = writeReport(ctx, rows, byId, Date.now() - started);
  // the dashboard on the fork needs this fork's SDK pins (release pins are empty until launch)
  if (ctx.shared.pins) {
    writeFileSync(join(STATE, "web-pins.json"), JSON.stringify(ctx.shared.pins));
    Bun.spawnSync(["/bin/bash", join(ROOT, "ops/fork/up.sh"), "web"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
  }
  console.log(`every-tx ${runId}: ${passed}/${byId.size} scenarios passed (${rows.filter((r) => r.result === "pass").length}/${rows.length} rows); report ${report}`);
  await redis.quit().catch(() => undefined);
  await closeDb(db);
  return { rows, passed, total: byId.size, report };
}

function writeReport(ctx: Ctx, rows: Row[], byId: Map<string, boolean>, ms: number): string {
  const day = new Date().toISOString().slice(0, 10);
  const dirOut = resolve(process.env.FORK_REPORT_DIR ?? join(ROOT, "../docs/reports"));
  const runsDir = join(dirOut, `fork-run-${day}`);
  mkdirSync(runsDir, { recursive: true });
  const esc = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
  const lines = [
    `## Run ${ctx.runId}`,
    "",
    `Fork blocks: ${existsSync(join(STATE, "fork-blocks.txt")) ? readFileSync(join(STATE, "fork-blocks.txt"), "utf8").trim() : "unknown"}. Took ${Math.round(ms / 1000)} s.`,
    `Scenarios: ${[...byId.values()].filter(Boolean).length}/${byId.size} passed. Contracts: ${ctx.deployed ? `CPST ${ctx.deployed.cpst}, CPSTLock ${ctx.deployed.lock}, Anchor ${ctx.deployed.anchor}` : "not deployed"}.`,
    "",
    "| Scenario | Step | Tx hash or request id | Gas | Result | Receipt id | Check |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.id} | ${esc(r.scenario)} | ${esc(r.ref)} | ${r.gas} | ${r.result} | ${esc(r.receipt)} | ${esc(r.check)}${r.error ? `: ${esc(r.error)}` : ""} |`),
    "",
  ];
  const file = join(runsDir, `${ctx.runId}.md`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  writeFileSync(join(runsDir, `${ctx.runId}.json`), JSON.stringify({ runId: ctx.runId, rows, gas: Object.fromEntries(Object.entries(ctx.gas).map(([k, v]) => [k, v.toString()])) }, null, 2));
  return file;
}

if (import.meta.main) {
  const r = await main();
  process.exit(r.passed === r.total ? 0 : 1);
}
void API;
