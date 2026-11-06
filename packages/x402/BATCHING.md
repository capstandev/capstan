# x402 batching: evaluation of the standard `batch-settlement` scheme

Status: evaluated 2026-11-06. Decision for v1: settle every paid call with the `exact` scheme. No custom vouchers.

## What the standard scheme is

`batch-settlement` is part of the x402 v2 spec and of `@x402/evm` (2.29.0 exports `batch-settlement/client`,
`/server`, `/facilitator`, plus Redis and file channel storage for the server). The payer deposits once into an
escrow channel held by the `x402BatchSettlement` contract and then signs a cumulative voucher per request. The
server keeps the latest voucher per channel and claims many vouchers in one `claimWithSignature(VoucherClaim[], bytes)`
transaction. Unused deposit is refunded to the payer.

## What was checked

| Item | Result |
|---|---|
| Contract `x402BatchSettlement` `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` on RHC 4663 | code present (11,175 bytes, read on an anvil fork of 4663) |
| Same address on RHC 46630, Base 8453, Base Sepolia 84532 | code present (read-only `eth_getCode`, research file section 3) |
| Deposit collectors `...0004`, `...0005` | code present on all four chains |
| SDK support | client, server and facilitator classes exist; the server needs channel storage (Redis) and a receiver authorizer key |
| Client support in the wild | only clients built on `@x402/evm` with the batch client registered; `@x402/fetch` alone does not open channels |
| Public reference facilitator | lists `batch-settlement` on Base Sepolia only |
| Audit report for the contract | none found |

## Why per-call `exact` stays the v1 path

1. Interoperability. Every x402 v2 client can pay `exact`. A batch-only route would refuse most agents.
2. Maturity. The scheme is new, the contract has no published audit, and channels add state the server must keep
   safe (lost voucher storage means lost revenue; a bug in claim ordering can double-claim or under-claim).
3. Operations. The facilitator would hold a second key (the receiver authorizer) and run a claim job. That is more
   key material and more failure modes than v1 needs.
4. The evaluation did not fail. The scheme exists and is deployed, so custom vouchers are not built (they would be
   strictly worse: non-standard and unaudited).

## The cost pressure that may change this

Fork measurements (2026-11-06, first payment to a fresh payee): Base USDC `transferWithAuthorization` 102,828 gas;
RHC USDG `transferWithAuthorization` 102,495 gas; RHC USDG through the x402 Permit2 proxy 118,951 gas.
At the RHC gas price read on 2026-11-06 (0.0211 gwei) and ETH near $2,230 one RHC settle costs about $0.005 to
$0.006, which is more than half of a $0.01 call. The boot economics check (REL-3) therefore drops the RHC rails while
gas stays at that level, and Base USDC (about $0.0015 per settle) and Solana USDC remain. Note that anvil does not
model the Arbitrum Orbit L1 data component, so the real RHC cost per settle is at least this.

Batching is the standard way out of this: one claim amortised over many vouchers.

## Gas per voucher, measured on forks

Measured 2026-11-06 by `packages/x402/test/fork/batching-gas.test.ts` (`gas-per-voucher-rhc`, `gas-per-voucher-base`):
the SDK's own facilitator scheme (`BatchSettlementEvmScheme`, @x402/evm 2.29.0) against the deployed
`x402BatchSettlement` contract on local anvil forks, fresh in-memory keys, 111 channels of $1 each, every channel's
latest voucher at $0.50 (50 calls at $0.01). Rerun with `RHC_FORK_URL=<local fork of 4663>` or `BASE_RPC_URL=<Base RPC>`.

| Step (gas used) | RHC 4663, USDG | Base 8453, USDC |
|---|---|---|
| Deposit (EIP-3009 collector), per channel | 143,586 | 140,996 |
| `claimWithSignature`, 1 channel | 77,772 | 77,760 |
| `claimWithSignature`, 10 channels | 276,268 (27,627 each) | 276,400 (27,640 each) |
| `claimWithSignature`, 100 channels | 2,448,118 (24,481 each) | 2,449,234 (24,492 each) |
| `settle` (payout to the receiver, all channels) | 77,135 | 73,940 |
| `refundWithSignature` (unused deposit back) | 98,805 | 95,598 |
| For comparison: one `exact` settle | 102,495 | 102,828 |

A voucher is cumulative, so one claimed voucher covers every call made on that channel since the last claim. The
marginal cost of a channel in a 100-channel claim is about 24,100 gas.

What one channel costs end to end on RHC (deposit + its share of a 100-channel claim + its share of one settle + a
refund): about 143,600 + 24,500 + 800 + 98,800 = 267,700 gas, or about 168,900 gas when the deposit is used up and no
refund is needed. Per call:

| Calls per channel | Gas per call, with refund | Without refund | `exact` per call |
|---|---|---|---|
| 1 | 267,700 | 168,900 | 102,495 |
| 3 | 89,200 | 56,300 | 102,495 |
| 10 | 26,800 | 16,900 | 102,495 |
| 100 | 2,700 | 1,700 | 102,495 |

So batching wins from about 3 calls per channel (2 without a refund) and is about 38 times cheaper at 100 calls. At
the RHC gas price read on 2026-11-06 (`cast gas-price`: 0.0206 gwei) and ETH near $2,230, 100 calls on one channel
cost about $0.00012 each in gas, against about $0.0047 for an `exact` settle, so a $0.01 route would pass the REL-3
rule on RHC with batching. The same caveat applies: anvil does not model the Orbit L1 data component, so real costs are
higher per transaction (and batching saves more, since it sends fewer transactions).

The cost does not change the v1 decision above: interoperability, the missing audit and the second key still apply.
It does say batching is the right lever if the dropped RHC rails become a real loss (BACKLOG C33, C34).

## Revisit when

- the contract has a public audit, and
- at least one widely used agent client opens batch channels by default, or
- RHC USDG volume makes the dropped rail a real loss.
