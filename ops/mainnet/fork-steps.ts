// Fork-only steps for ops/mainnet/dry-run.sh. Every write goes to the loopback dry-run anvil (localRpc refuses any
// other URL). Test wallets are fresh in-memory keys for this run only; nothing here prints a key.
//   bun ops/mainnet/fork-steps.ts safe   --rpc URL --out FILE      Safe 1.4.1 (SafeL2 singleton), 2 of 3 fresh owners
//   bun ops/mainnet/fork-steps.ts settle --rpc URL --safe ADDR --keystore F --password-file F --method permit2|eip3009 --out FILE
import { keystoreSigner } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { acceptsFor, facilitatorEvmSigner, PERMIT2, readTokenInfo, type X402State } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme as ClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as FacilitatorScheme } from "@x402/evm/exact/facilitator";
import { writeFileSync } from "node:fs";
import { createTestClient, createWalletClient, encodeFunctionData, http, maxUint256, parseAbi, toHex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { setTokenBalance } from "../../packages/x402/test/helpers/chain";
import { args, chainOf, localRpc, MAINNET_CHAIN_ID, SAFE_141, USDG } from "./lib";

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const SAFE_ABI = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);

async function fundEth(url: string, addr: Hex, wei: bigint): Promise<void> {
  localRpc(url);
  await createTestClient({ mode: "anvil", transport: http(url) }).setBalance({ address: addr, value: wei });
}

async function send(pc: PublicClient, url: string, acct: PrivateKeyAccount, to: Hex, data: Hex) {
  const wc = createWalletClient({ account: acct, chain: chainOf(MAINNET_CHAIN_ID, url), transport: http(url) });
  const hash = await wc.sendTransaction({ to, data, chain: chainOf(MAINNET_CHAIN_ID, url) });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx ${hash} reverted`);
  return rc;
}

/** A Safe 1.4.1 made the way the Safe app makes one on an L2: canonical factory, SafeL2 singleton, fallback handler. */
async function safe(url: string, out: string): Promise<void> {
  const pc = localRpc(url);
  const operator = privateKeyToAccount(generatePrivateKey());
  await fundEth(url, operator.address, 10n ** 17n);
  const owners = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address);
  const init = encodeFunctionData({ abi: SAFE_ABI, functionName: "setup", args: [owners, 2n, ZERO, "0x", SAFE_141.fallback, ZERO, 0n, ZERO] });
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const rc = await send(pc, url, operator, SAFE_141.factory, encodeFunctionData({ abi: SAFE_ABI, functionName: "createProxyWithNonce", args: [SAFE_141.singletonL2, init, salt] }));
  const log = rc.logs.find((l) => l.address.toLowerCase() === SAFE_141.factory.toLowerCase());
  if (!log?.topics[1]) throw new Error("no ProxyCreation log");
  const address = `0x${log.topics[1].slice(26)}` as Hex;
  writeFileSync(out, `${JSON.stringify({ address, owners, threshold: 2, singleton: SAFE_141.singletonL2, tx: rc.transactionHash, gas: rc.gasUsed.toString() }, null, 2)}\n`);
  console.log(address);
}

/**
 * One USDG x402 settle through the production pieces: the 402 option from acceptsFor (token facts read and proven
 * on chain), the stock x402 client on the payer side, and on the facilitator side the stock exact EVM scheme over
 * Capstan's facilitatorEvmSigner with the facilitator keystore (chain id asserted before the send).
 */
async function settle(o: Record<string, string>): Promise<void> {
  const url = o.rpc!;
  const pc = localRpc(url);
  const method = o.method === "eip3009" ? "eip3009" : "permit2";
  const signer = await keystoreSigner(o.keystore!, o["password-file"]!, { allowedChainIds: [MAINNET_CHAIN_ID] });
  const info = await readTokenInfo(pc, USDG, MAINNET_CHAIN_ID, { hardVersion: "1", expectName: "Global Dollar" });
  const state: X402State = {
    usdgEip3009: { "4663": true, "46630": false },
    payTo: { evm: o.safe as Hex, sol: "So1PayTo1111111111111111111111111111111111" },
    tokens: { "rhc-usdg-permit2": info, "rhc-usdg-eip3009": info },
    eip3009MainnetEnabled: method === "eip3009",
    hotKeys: [signer.address],
  };
  const route = { usd: "0.01", description: "dry run" };
  const req = acceptsFor(route, state, "mainnet").find((a) => a.network === "eip155:4663" && ((a.extra as { assetTransferMethod?: string }).assetTransferMethod ?? "eip3009") === method);
  if (!req) throw new Error(`the 402 offers no RHC USDG ${method} option`);
  const payer = privateKeyToAccount(generatePrivateKey());
  await setTokenBalance(url, USDG, payer.address, 1_000_000n);
  let approveGas = 0n;
  if (method === "permit2") {
    await fundEth(url, payer.address, 10n ** 16n);
    approveGas = (await send(pc, url, payer, USDG, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [PERMIT2, maxUint256] }))).gasUsed;
  }
  const required: PaymentRequired = { x402Version: 2, resource: { url: "https://api.example.invalid/v1/dry-run", description: "dry run", mimeType: "application/json" }, accepts: [req] };
  const client = new x402Client(() => req);
  client.register("eip155:4663", new ClientScheme(payer));
  client.setSpendControls(false); // a throwaway fork payer
  const payload = await client.createPaymentPayload(required);
  const facilitator = new x402Facilitator();
  facilitator.register("eip155:4663", new FacilitatorScheme(facilitatorEvmSigner({ signer, client: pc, chainId: MAINNET_CHAIN_ID })));
  const before = await pc.readContract({ address: USDG, abi: ERC20, functionName: "balanceOf", args: [o.safe as Hex] });
  const v = await facilitator.verify(payload, req);
  if (!v.isValid) throw new Error(`verify refused: ${v.invalidReason ?? "unknown"}`);
  const s = await facilitator.settle(payload, req);
  if (!s.success || !s.transaction) throw new Error(`settle failed: ${s.errorReason ?? "unknown"}`);
  const rc = await pc.getTransactionReceipt({ hash: s.transaction as Hex });
  const after = await pc.readContract({ address: USDG, abi: ERC20, functionName: "balanceOf", args: [o.safe as Hex] });
  const moved = after - before;
  const row = { method, tx: s.transaction, gas: rc.gasUsed.toString(), status: rc.status, from: rc.from, facilitator: signer.address, amount: req.amount, payToGained: moved.toString(), payTo: o.safe, approveGas: approveGas.toString(), ok: rc.status === "success" && moved === BigInt(req.amount) };
  writeFileSync(o.out!, `${JSON.stringify(row, null, 2)}\n`);
  console.log(`${method} settle ${row.ok ? "ok" : "FAILED"}: gas ${row.gas}, payTo +${moved} (asked ${req.amount})`);
  if (!row.ok) process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const o = args(rest);
if (cmd === "safe") await safe(o.rpc!, o.out!);
else if (cmd === "settle") await settle(o);
else {
  console.error("usage: fork-steps.ts safe|settle --rpc URL ...");
  process.exit(2);
}
