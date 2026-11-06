// x402 through the running api and facilitator: S5 RHC USDG on the 4663 fork (Permit2 path, EIP-3009 path, and the
// detection flip when USDG's implementation is swapped for a mock without EIP-3009), S6 Base USDC on the 8453 fork.
// Payers are fresh in-memory wallets given token balances by storage writes on the fork only.
import { runUsdgDetection } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, encodeFunctionData, http, maxUint256, pad, type Hex } from "viem";
import { compileMocks, setTokenBalance } from "../../../packages/x402/test/helpers/chain";
import { API, BASE, base, ERC20_ABI, freshWallet, RHC, rhc, send, setBalance, USDC_BASE, USDG, type Row } from "../lib";
import type { Ctx } from "../every-tx";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Hex;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex; // not-a-key (EIP-1967 implementation slot)
const ROUTE = "/spreads/scan"; // $0.02: the RHC USDG rails cost about $0.006 to settle, so they serve $0.02 routes

interface Offer { accepts: PaymentRequirements[]; raw: string }

async function offers(): Promise<Offer> {
  const r = await fetch(`${API}${ROUTE}`);
  if (r.status !== 402) throw new Error(`expected 402 from ${ROUTE}, got ${r.status}`);
  const raw = r.headers.get("PAYMENT-REQUIRED") ?? "";
  return { accepts: (JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepts: PaymentRequirements[] }).accepts, raw };
}

const methodOf = (a: PaymentRequirements) => (a.extra as { assetTransferMethod?: string } | undefined)?.assetTransferMethod ?? "eip3009";

async function payAndCall(req: PaymentRequirements, payer: ReturnType<typeof freshWallet>, raw: string): Promise<{ status: number; tx: Hex | null; body: string }> {
  const client = new x402Client(() => req);
  client.register(req.network as `${string}:${string}`, new ExactEvmScheme(payer));
  client.setSpendControls(false); // the payer is a throwaway fork wallet; the SDK's own controls are tested in packages/sdk
  const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  const payload = await client.createPaymentPayload({ ...required, accepts: [req] });
  const r = await fetch(`${API}${ROUTE}`, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  const pr = r.headers.get("PAYMENT-RESPONSE");
  const tx = pr ? ((JSON.parse(Buffer.from(pr, "base64").toString("utf8")) as { transaction?: Hex }).transaction ?? null) : null;
  return { status: r.status, tx, body: (await r.text()).slice(0, 160) };
}

async function settleRow(ctx: Ctx, id: string, label: string, gasKey: string, req: PaymentRequirements | undefined, raw: string, chain: "rhc" | "base", prep?: (p: ReturnType<typeof freshWallet>) => Promise<void>): Promise<Row> {
  if (!req) return { id, scenario: label, ref: "-", gas: "-", result: "fail", receipt: "-", check: "the 402 does not offer this rail" };
  const payer = freshWallet();
  const url = chain === "rhc" ? RHC : BASE;
  const pc = chain === "rhc" ? rhc : base;
  await setTokenBalance(url, req.asset as Hex, payer.address, 1_000_000n);
  if (prep) await prep(payer);
  const before = await pc.readContract({ address: req.asset as Hex, abi: ERC20_ABI, functionName: "balanceOf", args: [req.payTo as Hex] });
  const r = await payAndCall(req, payer, raw);
  const after = await pc.readContract({ address: req.asset as Hex, abi: ERC20_ABI, functionName: "balanceOf", args: [req.payTo as Hex] });
  let gas = "-";
  if (r.tx && r.status === 200) {
    const t = await pc.getTransactionReceipt({ hash: r.tx });
    gas = String(t.gasUsed);
    ctx.gas[gasKey] = t.gasUsed;
  }
  const moved = after - before;
  return { id, scenario: label, ref: r.tx ?? `GET /v1${ROUTE}`, gas, result: r.status === 200 && moved === BigInt(req.amount) ? "pass" : "fail", receipt: "-", check: `${r.status}; payTo +${moved} (asked ${req.amount}) ${r.status !== 200 ? r.body : ""}` };
}

/** Wait until the api's rail state (refreshed every minute from x402_detections) shows or hides the eip3009 rail. */
async function waitForRail(present: boolean, ms = 90_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const o = await offers();
    if (o.accepts.some((a) => a.network === "eip155:4663" && methodOf(a) === "eip3009") === present) return true;
    await Bun.sleep(3_000);
  }
  return false;
}

export async function s5(ctx: Ctx): Promise<Row[]> {
  const rows: Row[] = [];
  const o = await offers();
  const p2 = o.accepts.find((a) => a.network === "eip155:4663" && methodOf(a) === "permit2");
  const e3 = o.accepts.find((a) => a.network === "eip155:4663" && methodOf(a) === "eip3009");
  rows.push(await settleRow(ctx, "S5", "x402 RHC USDG Permit2 path settles (approve Permit2 once, then the signed witness)", "x402 rhc permit2", p2, o.raw, "rhc", async (payer) => {
    await setBalance(payer.address, 10n ** 16n);
    await send(payer, USDG, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, maxUint256] }));
  }));
  rows.push(await settleRow(ctx, "S5", "x402 RHC USDG EIP-3009 path settles (no approval, transferWithAuthorization)", "x402 rhc eip3009", e3, o.raw, "rhc"));
  // the detection flip: USDG's implementation swapped for a mock without EIP-3009, on the fork only
  const original = await rhc.getStorageAt({ address: USDG, slot: IMPL_SLOT });
  const mock = compileMocks().MockNo3009!;
  const deployer = freshWallet();
  await setBalance(deployer.address, 10n ** 16n);
  const { createWalletClient } = await import("viem");
  const { chainOf } = await import("../lib");
  const wc = createWalletClient({ account: deployer, chain: chainOf(4663, RHC), transport: http(RHC) });
  const h = await wc.deployContract({ abi: mock.abi, bytecode: mock.bytecode, args: [] });
  const mockAddr = (await rhc.waitForTransactionReceipt({ hash: h })).contractAddress!;
  const detectRpc = { "4663": createPublicClient({ transport: http(RHC) }) };
  try {
    await rhc.request({ method: "anvil_setStorageAt" as never, params: [USDG, IMPL_SLOT, pad(mockAddr, { size: 32 })] as never });
    const run = await runUsdgDetection(ctx.db, detectRpc);
    const gone = await waitForRail(false);
    rows.push({ id: "S5", scenario: "USDG implementation swapped for a mock without EIP-3009: detection flips off, the 402 drops the option", ref: `x402_detections ${String(run.results["4663"]?.reason ?? "").slice(0, 40)}`, gas: "-", result: run.results["4663"]?.supported === false && run.flippedToAbsent.includes("4663") && gone ? "pass" : "fail", receipt: "-", check: `supported ${run.results["4663"]?.supported}, flipped ${run.flippedToAbsent.join(",") || "none"}, 402 without eip3009 ${gone}` });
  } finally {
    await rhc.request({ method: "anvil_setStorageAt" as never, params: [USDG, IMPL_SLOT, original ?? pad("0x0", { size: 32 })] as never });
    await runUsdgDetection(ctx.db, detectRpc);
  }
  const back = await waitForRail(true);
  rows.push({ id: "S5", scenario: "implementation restored: detection back on, the option returns", ref: "x402_detections", gas: "-", result: back ? "pass" : "fail", receipt: "-", check: `402 offers eip3009 again ${back}` });
  return rows;
}

export async function s6(ctx: Ctx): Promise<Row[]> {
  const o = await offers();
  const b = o.accepts.find((a) => a.network === "eip155:8453");
  const row = await settleRow(ctx, "S6", "x402 Base USDC (\"USD Coin\" v2, EIP-3009) settles on the 8453 fork", "x402 base eip3009", b, o.raw, "base");
  const name = (b?.extra as { name?: string; version?: string } | undefined) ?? {};
  row.check = `${row.check}; domain ${name.name} v${name.version}`;
  if (b && (name.name !== "USD Coin" || name.version !== "2")) row.result = "fail";
  void USDC_BASE;
  return [row];
}
