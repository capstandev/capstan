// S7 the Lighter-RH USDG deposit (approve + deposit built by the adapter after its boot check, sent from the user's
// own wallet on the fork), and S11 the monthly burn: a CPST/USDG Uniswap v4 pool made on the fork, the read-only
// BurnPlan script writes the Safe batch, the brand Safe runs it (2 of 3 owners), and the CPST supply falls.
import { bootCheck, buildDepositTxs, LIGHTER_RH_DEPOSIT, lighterConfigsFor, lighterReaderFor, rhcSlotReader } from "@capstan/adapter-lighter";
import { createMemoryGovernor } from "@capstan/venue-client";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { setTokenBalance } from "../../../packages/x402/test/helpers/chain";
import { contractArtifact, ERC20_ABI, FORGE, freshWallet, PORTS, RHC, rhc, ROOT, run, send, setBalance, USDG, walletClient, type Row } from "../lib";
import type { Ctx } from "../every-tx";

export async function s7(ctx: Ctx): Promise<Row[]> {
  void ctx;
  const user = freshWallet();
  await setBalance(user.address, 10n ** 17n);
  await setTokenBalance(RHC, USDG, user.address, 25_000_000n); // 25 USDG
  const reader = lighterReaderFor(lighterConfigsFor(process.env)[1], createMemoryGovernor("fork"), null, { rest: `http://127.0.0.1:${PORTS.lighterRh}` });
  const boot = await bootCheck(reader, rhcSlotReader(RHC));
  const rows: Row[] = [{ id: "S7", scenario: "deposit boot check (pinned contract from /info, implementation slot on the fork)", ref: "read-only", gas: "-", result: boot.ok ? "pass" : "fail", receipt: "-", check: boot.ok ? `contract ${boot.contract}, implementation ${boot.implementation}` : String(boot.reason) }];
  if (!boot.ok) return rows;
  const decimals = await rhc.readContract({ address: USDG, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
  const txs = buildDepositTxs({ owner: user.address, amountUsdg: "20" }, { checked: true, nowMs: Date.now(), tokenDecimals: decimals });
  const before = await rhc.readContract({ address: USDG, abi: ERC20_ABI, functionName: "balanceOf", args: [LIGHTER_RH_DEPOSIT.address] });
  const a = await send(user, txs.approve.to, txs.approve.data);
  const d = await send(user, txs.deposit.to, txs.deposit.data);
  const after = await rhc.readContract({ address: USDG, abi: ERC20_ABI, functionName: "balanceOf", args: [LIGHTER_RH_DEPOSIT.address] });
  ctx.gas["Lighter-RH approve"] = a.gasUsed;
  ctx.gas["Lighter-RH deposit"] = d.gasUsed;
  rows.push({ id: "S7", scenario: "approve (exact 20 USDG) sent from the user's wallet", ref: a.transactionHash, gas: String(a.gasUsed), result: "pass", receipt: "-", check: txs.humanReadable[0]! });
  rows.push({ id: "S7", scenario: "deposit(owner, 3, 0, 20 USDG) to the Lighter-RH contract", ref: d.transactionHash, gas: String(d.gasUsed), result: after - before === 20_000_000n ? "pass" : "fail", receipt: "-", check: `contract USDG +${after - before} raw` });
  return rows;
}

// ---------------------------------------------------------------- S11 burn
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Hex;
const PM_ABI = parseAbi(["function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)"]);
const ADDER_ABI = parseAbi(["function add((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, int256 liquidity)"]);

export async function s11(ctx: Ctx): Promise<Row[]> {
  const d = ctx.deployed;
  const [c0, c1] = d.cpst.toLowerCase() < USDG.toLowerCase() ? [d.cpst, USDG] : [USDG, d.cpst];
  const key = { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" as Hex };
  const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  // 1 CPST = 0.01 USDG (BurnFixture.sqrtPrice)
  const sqrt = USDG.toLowerCase() < d.cpst.toLowerCase() ? 10_000_000n << 96n : (1n << 96n) / 10_000_000n;
  const rows: Row[] = [];
  const init = await send(ctx.operator, PM, encodeFunctionData({ abi: PM_ABI, functionName: "initialize", args: [key, sqrt] }));
  const art = contractArtifact("BurnFixture.sol", "LiquidityAdder"); // builds the test fixtures in a fresh clone
  const wc = walletClient(ctx.operator);
  const h = await wc.deployContract({ abi: ADDER_ABI, bytecode: art.bytecode.object, args: [] });
  const adder = (await rhc.waitForTransactionReceipt({ hash: h })).contractAddress!;
  await ctx.safe.exec(d.cpst, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [adder, 2_000_000n * 10n ** 18n] }), ctx.operator);
  await setTokenBalance(RHC, USDG, adder, 20_000_000_000n);
  const liq = await send(ctx.operator, adder, encodeFunctionData({ abi: ADDER_ABI, functionName: "add", args: [key, 10n ** 17n] }));
  rows.push({ id: "S11", scenario: "test CPST/USDG v4 pool on the fork (initialize + full-range liquidity)", ref: liq.transactionHash, gas: String(init.gasUsed + liq.gasUsed), result: "pass", receipt: "-", check: `pool ${poolId.slice(0, 18)}...` });
  // the brand Safe holds the burn budget
  await setTokenBalance(RHC, USDG, ctx.safe.address, 5_000_000_000n);
  mkdirSync(join(ROOT, "out/burn"), { recursive: true }); // forge's fs_permissions need the folder to exist (burn-plan.sh does the same)
  const out = run([FORGE, "script", "script/BurnPlan.s.sol:BurnPlan", "--rpc-url", RHC], { cwd: join(ROOT, "contracts"), env: { EXPECTED_CHAIN_ID: "4663", BRAND_SAFE: ctx.safe.address, CPST_ADDRESS: d.cpst, CPST_POOL: poolId, AMOUNT_USDG: "1000", BURN_FORCE: "1", BURN_OUT_DIR: "../out/burn" } });
  const file = /batch file: (.+)/.exec(out)?.[1]?.trim();
  const minOut = BigInt(/min out and burn \(raw CPST\): (\d+)/.exec(out)?.[1] ?? "0");
  if (!file) throw new Error(`BurnPlan wrote no batch: ${out.slice(-400)}`);
  const batch = JSON.parse(readFileSync(join(ROOT, "contracts", file), "utf8")) as { chainId: string; meta: { createdFromSafeAddress: string }; transactions: { to: Hex; data: Hex; value: string }[] };
  rows.push({ id: "S11", scenario: "BurnPlan (read-only): quote, slippage floor, 30 min deadline, Safe batch file", ref: "forge script (no broadcast)", gas: "-", result: batch.chainId === "4663" && batch.meta.createdFromSafeAddress.toLowerCase() === ctx.safe.address.toLowerCase() && minOut > 0n ? "pass" : "fail", receipt: "-", check: `${batch.transactions.length} txs, min out and burn ${minOut / 10n ** 18n} CPST` });
  const supply0 = await rhc.readContract({ address: d.cpst, abi: ERC20_ABI, functionName: "totalSupply" });
  let gas = 0n;
  let last: Hex = "0x";
  for (const t of batch.transactions) {
    const r = await ctx.safe.exec(t.to, t.data, ctx.operator);
    gas += r.gasUsed;
    last = r.transactionHash;
  }
  const supply1 = await rhc.readContract({ address: d.cpst, abi: ERC20_ABI, functionName: "totalSupply" });
  ctx.gas["burn batch (all Safe txs)"] = gas;
  rows.push({ id: "S11", scenario: "the brand Safe executes the batch (approve, Permit2, swap, burn), 2 of 3 owners", ref: last, gas: String(gas), result: supply0 - supply1 === minOut ? "pass" : "fail", receipt: "-", check: `totalSupply fell by ${(supply0 - supply1) / 10n ** 18n} CPST (minOut ${minOut / 10n ** 18n})` });
  return rows;
}
