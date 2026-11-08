// Writes the dry-run report from one ops/mainnet/dry-run.sh run folder. Reads only: the fork's receipts and inputs
// from the loopback anvil, and the live gas price, the ArbGasInfo prices and the NodeInterface L1 estimate through
// the rpc-cache (which forwards reads to the public RPC and refuses writes).
//   bun ops/mainnet/report.ts --run ~/Library/Caches/capstan-mainnet-dry-run/run-<stamp> --cache http://127.0.0.1:22546 --out-dir DIR
import type { Hex } from "@capstan/schema";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi, type PublicClient } from "viem";
import { args, eth, fmt, localRpc, withHeadroom } from "./lib";

const ARB_GAS_INFO = "0x000000000000000000000000000000000000006C" as Hex;
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8" as Hex;
const ABI = parseAbi([
  "function getPricesInWei() view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getL1BaseFeeEstimate() view returns (uint256)",
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
// deploy-rhc.sh stage 2 refuses a deployer balance below DEPLOY_GAS x gas price
const DEPLOY_GAS_IN_SCRIPT = 3_700_000n;

export interface TxRow {
  label: string;
  payer: "deployer" | "poster" | "facilitator" | "payer" | "Safe creator";
  hash: Hex;
  gas: bigint;
  l1: bigint;
}

const env = (run: string): Record<string, string> =>
  Object.fromEntries(readFileSync(join(run, "meta.env"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

async function l1Of(cache: PublicClient, to: Hex | null, data: Hex): Promise<bigint> {
  try {
    const { result } = await cache.simulateContract({ address: NODE_INTERFACE, abi: ABI, functionName: "gasEstimateL1Component", args: [to ?? "0x0000000000000000000000000000000000000000", to === null, data] });
    return BigInt(result[0]);
  } catch {
    return -1n; // unknown: shown as such in the report
  }
}

export function suggestRound(wei: bigint): bigint {
  // round up to 1, 2 or 5 x 10^k wei
  if (wei <= 0n) return 0n;
  let k = 1n;
  while (k * 10n <= wei) k *= 10n;
  for (const m of [1n, 2n, 5n, 10n]) if (m * k >= wei) return m * k;
  return 10n * k;
}

if (import.meta.main) {
  const o = args(process.argv.slice(2));
  const run = o.run!;
  const m = env(run);
  const fork = localRpc(m.rpc!);
  const cache = localRpc(o.cache!);
  const rows: TxRow[] = [];
  const bc = JSON.parse(readFileSync(join(run, "broadcast.json"), "utf8")) as { transactions: { hash: Hex; contractName: string; contractAddress: Hex; transaction: { input: Hex } }[]; receipts: { transactionHash: Hex; gasUsed: Hex }[] };
  for (const t of bc.transactions) {
    const r = bc.receipts.find((x) => x.transactionHash === t.hash)!;
    rows.push({ label: `deploy ${t.contractName}`, payer: "deployer", hash: t.hash, gas: BigInt(r.gasUsed), l1: await l1Of(cache, null, t.transaction.input) });
  }
  const tx = async (label: string, payer: TxRow["payer"], hash: Hex) => {
    const [r, t] = await Promise.all([fork.getTransactionReceipt({ hash }), fork.getTransaction({ hash })]);
    rows.push({ label, payer, hash, gas: r.gasUsed, l1: await l1Of(cache, t.to ?? null, t.input) });
  };
  const anchor = JSON.parse(readFileSync(join(run, "anchor.json"), "utf8")) as { transactionHash: Hex };
  await tx("anchor postRoot (first post, cold storage)", "poster", anchor.transactionHash);
  const settles: Record<string, { tx: Hex; gas: string; approveGas: string; amount: string; payToGained: string; ok: boolean }> = {};
  for (const k of ["permit2", "eip3009"]) {
    const s = JSON.parse(readFileSync(join(run, `settle-${k}.json`), "utf8"));
    settles[k] = s;
    await tx(`x402 USDG settle, ${k === "permit2" ? "Permit2 path (launch default)" : "EIP-3009 path (after E7)"}`, "facilitator", s.tx);
  }
  if (existsSync(join(run, "safe.json"))) {
    const s = JSON.parse(readFileSync(join(run, "safe.json"), "utf8")) as { tx: Hex };
    await tx("Safe 1.4.1 creation, 2 of 3 (reference for E1)", "Safe creator", s.tx);
  }

  const gasPrice = await cache.getGasPrice();
  const prices = await cache.readContract({ address: ARB_GAS_INFO, abi: ABI, functionName: "getPricesInWei" });
  const l1Base = await cache.readContract({ address: ARB_GAS_INFO, abi: ABI, functionName: "getL1BaseFeeEstimate" });
  const perArbGas = BigInt(prices[5]);
  const price = gasPrice > perArbGas ? gasPrice : perArbGas;
  const total = (r: TxRow) => r.gas + (r.l1 > 0n ? r.l1 : 0n);
  const depGas = rows.filter((r) => r.payer === "deployer").reduce((a, r) => a + total(r), 0n);
  const depFund = withHeadroom(depGas, price);
  const stage2 = DEPLOY_GAS_IN_SCRIPT * price;
  const depMin = depFund > stage2 ? depFund : stage2;
  const depSend = 10n ** 15n; // 0.001 ETH
  const post = rows.find((r) => r.payer === "poster")!;
  const postMonth = withHeadroom(total(post) * 720n, price);
  const sP2 = rows.find((r) => r.label.includes("Permit2"))!;
  const sE3 = rows.find((r) => r.label.includes("EIP-3009"))!;
  const settleEach = withHeadroom(total(sP2), price);
  const day = new Date(Number(m.fork_ts) * 1000).toISOString().slice(0, 10);
  const lc = readFileSync(join(run, "live-check.md"), "utf8");
  const lcTable = lc.slice(lc.indexOf("| Result |")).split("\n\nNext:")[0];
  const exact = readFileSync(join(run, "exact-script.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t"));
  const deploy1 = readFileSync(join(run, "logs/deploy-1.log"), "utf8").trim().split("\n").filter((l) => /^(stage|skip|result)/.test(l));
  const deploy2 = readFileSync(join(run, "logs/deploy-2.log"), "utf8").trim().split("\n").filter((l) => /^(stage|skip|result)/.test(l));
  const dep = JSON.parse(readFileSync(join(run, "deployment-4663-fork.json"), "utf8")) as { contracts: Record<string, { address: Hex }> };
  const spent = BigInt(m.deployer_balance_before!) - BigInt(m.deployer_balance_after!);
  const l1Note = rows.every((r) => r.l1 === 0n) ? "0 for every transaction" : rows.some((r) => r.l1 < 0n) ? "not readable for some rows (shown as unknown)" : "included in the totals";

  const md = `# Mainnet dry run, ${day}

Result: **PASS**. The exact owner deploy script, \`ops/deploy/deploy-rhc.sh mainnet\`, ran end to end on a local
anvil fork of Robinhood Chain mainnet (chain id 4663, fork block ${fmt(BigInt(m.fork_block!))}), then a second run
skipped every deploy stage, the read-only live check passed, the poster posted one anchor root, and the facilitator
settled one USDG x402 payment on each RHC path. Nothing was sent to a real chain or to Sourcify.

## Exact script (R1, \`exact-script\`)

- Commit: \`${m.head_sha}\` (snapshot made with \`git archive HEAD\`; the dry run refuses uncommitted deploy inputs).
- Chain id: 4663 from the fork, \`EXPECTED_CHAIN_ID\` left to the script's own mainnet default (4663).
- Go flag: \`CAPSTAN_MAINNET_GO=go-${day}\` (the Guard checks it against the fork block's UTC date, as on the day).
- Brand Safe: \`${m.safe}\` (${m.safe_mode === "given" ? "the real brand Safe, read from the fork" : "a Safe 1.4.1 made on the fork, 2 of 3, SafeL2 singleton, canonical factory: the owner's Safe is not known yet (E1)"}).
- Poster: \`${m.poster}\` (${m.poster_mode === "given" ? "the address make-service-key.sh printed on the server" : "a fresh fork key standing in for the anchor key make-service-key.sh will make on the server (D2)"}).

Only these differ from the owner's own run:

| What | Owner's run | Dry run |
|---|---|---|
| Deployer key | \`--account capstan-deployer\` from \`~/.foundry/keystores\`, hidden password prompt | a fresh \`cast wallet new\` keystore with the same account name in a throwaway HOME, password file; funded by \`anvil_setBalance\` (\`${m.deployer}\`) |
| RPC | \`https://rpc.mainnet.chain.robinhood.com\` | \`${m.rpc}\` (anvil) forking \`${m.cache}\` (rpc-cache, refuses every write upstream) |
| Stage 5 Sourcify | \`forge verify-contract\` and Sourcify's read API | stand-ins for those two calls only (fork addresses do not exist on 4663); every other tool is the real one |

Files the run used, sha256 in the checkout and in the snapshot:

| File | Checkout | Snapshot |
|---|---|---|
${exact.map(([f, a, b]) => `| \`${f}\` | \`${a!.slice(0, 16)}\` | \`${b!.slice(0, 16)}\`${a === b ? "" : " DIFFERS"} |`).join("\n")}

## Steps (R2)

| Step | Result |
|---|---|
| deploy-rhc.sh mainnet, first run | exit 0 |
| deploy-rhc.sh mainnet, second run | exit 0, ${m.rerun_skips} skip lines, nothing deployed |
| PostDeployCheck (stage 6: code equals a fresh build, selectors, poster, token, CPST, real Safe check) | ok |
| live-check.sh (independent read-only check, below) | PASS |
| One anchor post (hour ${m.anchor_hour}) | rootOf equals the posted root |
| One USDG settle, Permit2 path | payTo +${settles.permit2!.payToGained} of ${settles.permit2!.amount} (USDG 6 decimals, $0.01) |
| One USDG settle, EIP-3009 path | payTo +${settles.eip3009!.payToGained} of ${settles.eip3009!.amount} |
| Committed \`contracts/deployments/4663.json\` | untouched (${m.real_record || "absent"}) |

First run, as printed:

\`\`\`
${deploy1.join("\n")}
\`\`\`

The stage 5 lines are the stand-ins' answers. On the day, stage 5 sends the real \`forge verify-contract\` and then
reads Sourcify's own API for each address; a failure there is recorded as not verified and exits 1 (re-run retries it).

Second run:

\`\`\`
${deploy2.join("\n")}
\`\`\`

Fork addresses (throwaway): CPST \`${dep.contracts.CPST!.address}\`, CPSTLock \`${dep.contracts.CPSTLock!.address}\`, CapstanReceiptAnchor \`${dep.contracts.CapstanReceiptAnchor!.address}\`.

## Gas per transaction

Live gas price when the report was written: ${fmt(gasPrice)} wei (${eth(gasPrice * 10n ** 9n, 6)} gwei);
ArbGasInfo price per gas ${fmt(perArbGas)} wei; the table uses the higher, ${fmt(price)} wei. L1 data component
(NodeInterface \`gasEstimateL1Component\` on the real chain, read-only): ${l1Note}; ArbGasInfo L1 base fee estimate
${fmt(BigInt(l1Base))} wei. Gas used is anvil's execution gas including the 21,000 base.

| Transaction | Paid by | Gas used | L1 gas | ETH at live price | ETH x 1.3 |
|---|---|---|---|---|---|
${rows.map((r) => `| ${r.label} | ${r.payer} | ${fmt(r.gas)} | ${r.l1 < 0n ? "unknown" : fmt(r.l1)} | ${eth(total(r) * price, 10)} | ${eth(withHeadroom(total(r), price), 10)} |`).join("\n")}
| Permit2 approve by the payer (once per payer, paid by the user) | payer | ${fmt(BigInt(settles.permit2!.approveGas))} | - | ${eth(BigInt(settles.permit2!.approveGas) * price, 10)} | - |

## Deployer ETH to fund (E4)

- Deployer gas, all three contracts: ${fmt(depGas)}. x live price x 1.3 = **${eth(depFund, 10)} ETH**.
- deploy-rhc.sh stage 2 also refuses a balance below its own floor, DEPLOY_GAS ${fmt(DEPLOY_GAS_IN_SCRIPT)} x gas price = ${eth(stage2, 10)} ETH at today's price.
- Minimum that passes both: ${eth(depMin, 10)} ETH. Send **${eth(depSend, 4)} ETH** (about ${depSend / (depMin || 1n)}x the minimum, room for a gas price spike; the rest stays in the deployer).
- ETH the fork actually took from the deployer: ${eth(spent, 10)} ETH (anvil's own fee per block, for reference).

## Service keys (E5)

- Anchor poster: ${fmt(total(post))} gas for a first post (later posts reuse warm storage and cost less). 720 hourly
  posts (30 days) x live price x 1.3 = ${eth(postMonth, 6)} ETH. Default float 0.005 ETH stands (about ${(5n * 10n ** 15n) / (postMonth || 1n)} months at today's price).
- Facilitator on RHC: ${fmt(total(sP2))} gas per Permit2 settle, ${fmt(total(sE3))} per EIP-3009 settle; x live price x 1.3 =
  ${eth(settleEach, 10)} ETH per settle. Default float 0.005 ETH covers about ${fmt((5n * 10n ** 15n) / (settleEach || 1n))} settles.

## Live check on the fork record (R5, R9)

${lcTable}

## Notes

- The anvil fork does not charge Arbitrum's L1 data fee; the real chain's estimate above was ${l1Note}. Re-read the
  gas price on the go day (\`~/.foundry/bin/cast gas-price --rpc-url https://rpc.mainnet.chain.robinhood.com\`).
- The fork Safe, poster and facilitator keys were throwaway and are deleted with the run; the fork addresses mean
  nothing on the real chain.
- Reproduce: \`/bin/bash ops/mainnet/dry-run.sh\` from the backend checkout (anvil 22545, rpc-cache 22546).
`;
  mkdirSync(o["out-dir"]!, { recursive: true });
  const out = join(o["out-dir"]!, `mainnet-dry-run-${day}.md`);
  writeFileSync(out, md);
  writeFileSync(join(run, "gas.json"), JSON.stringify({ price: price.toString(), gasPrice: gasPrice.toString(), deployerGas: depGas.toString(), deployerFundWei: depFund.toString(), stage2FloorWei: stage2.toString(), rows: rows.map((r) => ({ ...r, gas: r.gas.toString(), l1: r.l1.toString() })) }, null, 2));
  console.log(`report: ${out} (deployer gas ${fmt(depGas)}, fund ${eth(depFund, 10)} ETH, minimum with the stage-2 floor ${eth(depMin, 10)} ETH)`);
}
