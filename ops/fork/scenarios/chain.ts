// On-chain scenarios against the fork contracts: S2 lock and unlock with the tier and builder fee seen by the api, and
// S11 the monthly burn plan executed by the brand Safe against a CPST/USDG Uniswap v4 pool made on the fork.
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { ERC20_ABI, freshWallet, revert, rhc, send, setBalance, snapshot, warp, type Row } from "../lib";
import type { Ctx } from "../every-tx";
import { ensureMarkets, intentOf, onboardUser } from "./money";

const LOCK_ABI = parseAbi(["function lock(uint256 amount, uint64 duration)", "function unlock()", "function lockedOf(address) view returns (uint256 amount, uint64 unlockAt)", "function DURATION_30D() view returns (uint64)"]);
const AMOUNT = 100_000n * 10n ** 18n;

const feeOf = (b: { payload: unknown; preview: unknown }) => {
  const a = (b.payload as { action?: { builder?: { f?: number } } }).action;
  return { f: a?.builder?.f, bps: (b.preview as { builderFeeBps?: number }).builderFeeBps };
};

export async function s2(ctx: Ctx): Promise<Row[]> {
  await ensureMarkets(ctx);
  const rows: Row[] = [];
  const u = await onboardUser(ctx);
  await setBalance(u.wallet.address, 10n ** 17n);
  const d = ctx.deployed;
  // the Safe-held supply moves to the test user by a Safe transaction (2 of 3 owner signatures)
  const st = await ctx.safe.exec(d.cpst, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [u.wallet.address, AMOUNT] }), ctx.operator);
  const bal = await rhc.readContract({ address: d.cpst, abi: ERC20_ABI, functionName: "balanceOf", args: [u.wallet.address] });
  rows.push({ id: "S2", scenario: "Safe tx: 100,000 CPST from the brand Safe to the test user", ref: st.transactionHash, gas: String(st.gasUsed), result: bal === AMOUNT ? "pass" : "fail", receipt: "-", check: `user balance ${bal / 10n ** 18n} CPST` });
  const ap = await send(u.wallet, d.cpst, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [d.lock, AMOUNT] }));
  const dur = await rhc.readContract({ address: d.lock, abi: LOCK_ABI, functionName: "DURATION_30D" });
  const lk = await send(u.wallet, d.lock, encodeFunctionData({ abi: LOCK_ABI, functionName: "lock", args: [AMOUNT, dur] }));
  const [locked, unlockAt] = await rhc.readContract({ address: d.lock, abi: LOCK_ABI, functionName: "lockedOf", args: [u.wallet.address] });
  ctx.gas["CPST approve"] = ap.gasUsed;
  ctx.gas["CPSTLock lock"] = lk.gasUsed;
  rows.push({ id: "S2", scenario: "approve + lock 100,000 CPST for 30 days", ref: lk.transactionHash, gas: String(lk.gasUsed), result: locked === AMOUNT ? "pass" : "fail", receipt: "-", check: `lockedOf ${locked / 10n ** 18n} CPST until ${new Date(Number(unlockAt) * 1000).toISOString()}` });
  // the api reads the lock: lock_holder tier, the 1 bp builder fee (f=10) on the Hyperliquid build
  const held = await u.client.buildOrder(intentOf({ limitPx: "71000" }), "hyperliquid", "relay");
  const fh = feeOf(held.build);
  rows.push({ id: "S2", scenario: "tier lock_holder: HL build carries f=10 (1 bp)", ref: `build ${held.build.buildId}`, gas: "-", result: fh.f === 10 && fh.bps === 1 ? "pass" : "fail", receipt: "-", check: `builder f=${fh.f}, preview ${fh.bps} bps` });
  // after 30 days: unlock; the tier drops to free (f=20) once the 60 s lock cache expires
  const snap = await snapshot();
  try {
    await warp(Number(dur) + 60);
    const ul = await send(u.wallet, d.lock, encodeFunctionData({ abi: LOCK_ABI, functionName: "unlock" }));
    ctx.gas["CPSTLock unlock"] = ul.gasUsed;
    const [after] = await rhc.readContract({ address: d.lock, abi: LOCK_ABI, functionName: "lockedOf", args: [u.wallet.address] });
    const back = await rhc.readContract({ address: d.cpst, abi: ERC20_ABI, functionName: "balanceOf", args: [u.wallet.address] });
    rows.push({ id: "S2", scenario: "unlock after the 30 days (fork clock warped)", ref: ul.transactionHash, gas: String(ul.gasUsed), result: after === 0n && back === AMOUNT ? "pass" : "fail", receipt: "-", check: `lockedOf ${after}, balance back ${back / 10n ** 18n} CPST` });
    await Bun.sleep(61_000);
    const free = await u.client.buildOrder(intentOf({ limitPx: "70000" }), "hyperliquid", "relay");
    const ff = feeOf(free.build);
    rows.push({ id: "S2", scenario: "tier back to free: HL build carries f=20 (2 bps)", ref: `build ${free.build.buildId}`, gas: "-", result: ff.f === 20 && ff.bps === 2 ? "pass" : "fail", receipt: "-", check: `builder f=${ff.f}, preview ${ff.bps} bps` });
  } finally {
    // the fork clock goes back to real time, so the x402 authorizations of a later run are not expired on arrival
    await revert(snap);
  }
  void freshWallet;
  return rows;
}

export type { Hex };
