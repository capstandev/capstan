// Todo 33 batching note (packages/x402/BATCHING.md): measure the standard batch-settlement scheme's gas on a local
// anvil fork, with the SDK's own facilitator scheme (BatchSettlementEvmScheme 2.29.0) against the deployed
// x402BatchSettlement contract. Measures: deposit (EIP-3009 collector), claimWithSignature for 1, 10 and 100
// channels, settle (receiver payout) and refundWithSignature. Prints the per-voucher cost for BATCHING.md.
// RHC 4663 (USDG) runs on RHC_FORK_URL; Base 8453 (USDC) starts its own fork on lane port 21847 from BASE_RPC_URL.
// Each skips without its variable. Fresh keys in memory only; never the anvil default accounts.
import { afterAll, describe, expect, test } from "bun:test";
import { ADDRESSES, type Hex } from "@capstan/schema";
import type { PaymentRequirements } from "@x402/core/types";
import { createBatchSettlementEIP3009DepositPayload, computeChannelId, signVoucher } from "@x402/evm/batch-settlement/client";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { createPublicClient, http, keccak256, parseAbi, toHex } from "viem";
import { NETWORKS, type EvmNetwork } from "../../src/networks";
import { readTokenInfo } from "../../src/tokens";
import { fund, haveFoundry, LANE_PORTS, setTokenBalance, startAnvil, type Anvil } from "../helpers/chain";
import { facilitatorEvmSigner } from "../../src/evm-signer";
import { assertLocal, freshPayer, hotKeySigner } from "./helpers";

const BATCH = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" as Hex;
const CHANNELS_ABI = parseAbi(["function channels(bytes32) view returns (uint128 balance, uint128 totalClaimed)"]);
const RHC = process.env.RHC_FORK_URL;
const BASE = process.env.BASE_RPC_URL;

interface GasReport {
  chain: string;
  deposit: bigint[];
  claim: Record<1 | 10 | 100, bigint>;
  settle: bigint;
  refund: bigint;
}

async function measure(url: string, chainId: number, network: EvmNetwork, token: Hex, hardVersion: string | undefined, label: string): Promise<GasReport> {
  assertLocal(url);
  const pc = createPublicClient({ transport: http(url) });
  expect(await pc.getChainId()).toBe(chainId);
  expect((await pc.getCode({ address: BATCH }))?.length ?? 0).toBeGreaterThan(2);
  const info = await readTokenInfo(pc, token, chainId, hardVersion ? { hardVersion } : {});
  // our facilitator signer over a keystore hot key (chain id asserted before each send), outside the exact-scheme
  // service: this measurement drives the SDK's batch scheme directly
  const hot = await hotKeySigner(`batch-${label}`, chainId);
  await fund(url, hot.address as Hex);
  const signer = facilitatorEvmSigner({ signer: hot, client: pc as never, chainId, receiptTimeoutMs: 30_000 });
  const authorizer = freshPayer(); // receiver authorizer key (in memory only)
  const payer = freshPayer();
  const receiver = freshPayer().address as Hex;
  const scheme = new BatchSettlementEvmScheme(signer, authorizer);
  const total = 111; // 1 + 10 + 100 channels
  const depositAtomic = 1_000_000n; // $1 per channel
  await setTokenBalance(url, token, payer.address as Hex, depositAtomic * BigInt(total + 1));
  const req: PaymentRequirements = {
    scheme: "batch-settlement",
    network,
    asset: token,
    amount: "10000",
    payTo: receiver,
    maxTimeoutSeconds: 3600,
    extra: { name: info.name, version: info.version, receiverAuthorizer: authorizer.address, withdrawDelay: 900 },
  };
  const gasOf = async (hash: string) => (await pc.getTransactionReceipt({ hash: hash as Hex })).gasUsed;

  // open one channel per salt with a $1 deposit (the first voucher in each deposit is $0.01)
  const channels = [] as { config: Parameters<typeof computeChannelId>[0]; id: Hex }[];
  const deposit: bigint[] = [];
  for (let i = 0; i < total; i++) {
    const config = { payer: payer.address as Hex, payerAuthorizer: payer.address as Hex, receiver, receiverAuthorizer: authorizer.address as Hex, token, withdrawDelay: 900, salt: keccak256(toHex(`capstan-batch-gas:${label}:${i}`)) };
    const p = await createBatchSettlementEIP3009DepositPayload(payer, 2, req, config, depositAtomic.toString(), "10000");
    const r = await scheme.settle({ x402Version: 2, accepted: req, payload: p.payload as Record<string, unknown> }, req);
    if (r.errorReason) console.log(`deposit ${i} refused: ${r.errorReason} ${r.errorMessage ?? ""}`);
    expect(r.errorReason).toBeUndefined();
    expect(r.success).toBe(true);
    deposit.push(await gasOf(r.transaction));
    channels.push({ config, id: computeChannelId(config, network) });
  }

  // each channel's latest cumulative voucher is $0.50 (50 calls at $0.01); one claim covers many channels
  const vouchers = await Promise.all(
    channels.map(async (c) => {
      const v = await signVoucher(payer, c.id, "500000", network);
      return { voucher: { channel: c.config, maxClaimableAmount: "500000" }, signature: v.signature, totalClaimed: "500000" };
    }),
  );
  const claim = {} as GasReport["claim"];
  let at = 0;
  for (const k of [1, 10, 100] as const) {
    const r = await scheme.settle({ x402Version: 2, accepted: req, payload: { type: "claim", claims: vouchers.slice(at, at + k) } }, req);
    expect(r.errorReason).toBeUndefined();
    claim[k] = await gasOf(r.transaction);
    at += k;
  }
  const st = await pc.readContract({ address: BATCH, abi: CHANNELS_ABI, functionName: "channels", args: [channels[110]!.id] });
  expect(st[1]).toBe(500_000n);

  const s = await scheme.settle({ x402Version: 2, accepted: req, payload: { type: "settle", receiver, token } }, req);
  expect(s.errorReason).toBeUndefined();
  const settle = await gasOf(s.transaction);

  // refund the unused $0.50 of the first channel to the payer
  const v0 = await signVoucher(payer, channels[0]!.id, "500000", network);
  const rf = await scheme.settle(
    {
      x402Version: 2,
      accepted: req,
      payload: { type: "refund", channelConfig: channels[0]!.config, voucher: { channelId: channels[0]!.id, maxClaimableAmount: "500000", signature: v0.signature }, amount: "500000", refundNonce: "0", claims: [] },
    },
    req,
  );
  expect(rf.errorReason).toBeUndefined();
  const refund = await gasOf(rf.transaction);
  return { chain: label, deposit, claim, settle, refund };
}

function report(g: GasReport): void {
  const mean = g.deposit.reduce((a, b) => a + b, 0n) / BigInt(g.deposit.length);
  console.log(`batch gas ${g.chain}: deposit first ${g.deposit[0]}, mean ${mean}`);
  for (const k of [1, 10, 100] as const) console.log(`batch gas ${g.chain}: claim ${k} channel(s) ${g.claim[k]} (${g.claim[k] / BigInt(k)} per voucher)`);
  console.log(`batch gas ${g.chain}: settle ${g.settle}, refund ${g.refund}`);
}

let fork: Anvil | undefined;
afterAll(async () => {
  await fork?.stop();
});

(RHC && haveFoundry ? describe : describe.skip)("batch-settlement gas on RHC 4663 fork (USDG)", () => {
  test("gas-per-voucher-rhc", async () => {
    const g = await measure(RHC!, 4663, NETWORKS.rhc, ADDRESSES.usdgRhc.address as Hex, "1", "rhc");
    report(g);
    // amortisation is real: 100 vouchers in one claim cost far less per voucher than one alone
    expect(g.claim[100] / 100n).toBeLessThan(g.claim[1] / 2n);
  }, 600_000);
});

(BASE && haveFoundry ? describe : describe.skip)("batch-settlement gas on Base 8453 fork (USDC)", () => {
  test("gas-per-voucher-base", async () => {
    fork = await startAnvil(LANE_PORTS.baseFork, { forkUrl: BASE! });
    const g = await measure(fork.url, 8453, NETWORKS.base, ADDRESSES.usdcBase.address as Hex, undefined, "base");
    report(g);
    expect(g.claim[100] / 100n).toBeLessThan(g.claim[1] / 2n);
  }, 600_000);
});
