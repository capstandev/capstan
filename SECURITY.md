# Security policy

## Reporting a vulnerability
Please report privately through GitHub's private vulnerability reporting on this repository ("Security" tab, "Report
a vulnerability"). Include the affected package, service or contract and steps or a proof of concept (a failing
test is ideal). Do not open a public issue and do not test against live venues with real funds. We aim to reply
within 72 hours and to share a fix plan within 7 days. There is no paid reward programme yet.

## Status
Pre-release. Nothing is deployed. The code has not had an external audit.

## Deployments
The deployment files in `contracts/deployments/<chainId>.json` are the only source of our contract addresses. This
table is generated from them (`bun ops/ci/gen-deployments.ts`) and CI fails if it differs.

<!-- deployments:start -->
No contracts are deployed yet.
<!-- deployments:end -->

The contracts have no owner, no pause and no upgrade path. A fix is a redeploy plus a change to the deployment file;
roots and locks on the old contracts stay readable and verifiable.

## Design rules that reports can hold us to
- **No user keys, ever.** No service accepts, stores, logs or imports a user private key, seed or mnemonic. CI fails
  on any such identifier in `apps/`. Only the client-side SDK (`packages/sdk`) holds the delegated trading key, on
  the user's own device or host.
- **Trade-only delegation.** No venue authorization asks for withdraw or transfer permission. Every adapter declares
  `canWithdraw: false` as a type-level literal.
- **No cross-venue margin.** Collateral stays siloed per venue and per chain; the schema has no object that pools
  collateral across venues.
- **Every routed action gets a signed receipt.** Receipts are chained per account and their hourly Merkle roots are
  posted to `CapstanReceiptAnchor` on Robinhood Chain.
- The SDK checks every built payload against the user's intent before signing. A tampered payload fails at the venue.
- **One signed-message format.** Every owner or agent signature that is not venue typed data uses one EIP-191 text
  format carrying purpose, host, chain id, nonce and expiry (`capstanMessage` in `packages/core`). The verifier checks
  the purpose, so a signature made for one purpose never works for another, and a nonce works once.
- **Deny by default.** Every API route declares its auth; a route without one is refused when the server starts.

## Invariants and the check that enforces each

| # | Invariant | Enforced by |
| --- | --- | --- |
| 1 | No code path accepts, stores, logs or imports a user private key, seed or mnemonic | `ops/ci/check-key-identifiers.ts` (pre-commit, `invariants` workflow, `bun test`), gitleaks job, config refuses raw key variables |
| 2 | No venue authorization asks for withdraw or transfer; every adapter declares `canWithdraw: false` | type-level literal (`packages/schema` test), `canWithdraw: true` grep (pre-commit, `invariants` workflow) |
| 3 | No cross-venue margin, no collateral netting, and no schema object that pools collateral across venues | `packages/schema/test/invariant3.test.ts` (`ts` job) |
| 4 | Every routed action produces a signed receipt | receipt service tests (`ts` job) and the hourly anchor |
| 5 | Banned words never appear in docs, copy, API strings or MCP tool descriptions | `ops/ci/check-banned-words.ts` (pre-commit, `invariants` workflow) |

## Roles and keys

| Role | Where it lives | Power | Never |
| --- | --- | --- | --- |
| User main wallet | The user's own wallet | Everything on the user's accounts | Seen by Capstan |
| Delegated venue key (Hyperliquid agent, Aster signer, Lighter API key) | The user's device, bot host or agent enclave | Trade only | Sent to or stored by Capstan |
| Receipt signer | Encrypted keystore on the server, its own Unix user | Signs receipts | Moves funds |
| Anchor poster | Encrypted keystore on the server, its own Unix user | Posts hourly roots to `CapstanReceiptAnchor` (its only power) | Moves funds |
| x402 facilitator hot key | Encrypted keystore on the server, its own Unix user | Submits x402 settlements (pays gas) | Holds more than a $200 float; collected funds sweep daily to the multisig |
| Hyperliquid builder wallet | Hardware wallet, one per venue | Receives builder fees, claims them | Signs user actions, shares an address with anything else |
| Aster builder wallet | Hardware wallet, separate address | Receives Aster Code fees, holds the venue's required balance | Same as above |
| Project multisig (Safe) | Several hardware signers | Holds the CPST supply, receives fee sweeps, runs the monthly burn | Has any power over the contracts (they have no owner) |

Service keys are loaded only through `keystoreSigner` (`packages/core/src/signer.ts`): a Web3 v3 keystore file and
a password file, never a key in an environment variable. The config loader refuses any variable named like a raw key.
A development signer exists for the local chain 31337 only and refuses every other chain id.

## Threat model

| Threat | Impact | Mitigation |
| --- | --- | --- |
| Capstan servers fully compromised | Cannot trade or withdraw (no keys). Can drop, delay or mis-quote orders, or issue bad payloads | The SDK verifies every payload field and digest against the intent; the venue caps the builder fee at the approved maximum; receipts expose any change; the SDK pins onboarding template hashes |
| Relay alters a signed payload | None: the signature fails at the venue | Venue signature check; relay dedupe by payload hash |
| Phishing typed data (fake onboarding) | The user approves an attacker's agent or builder | The SDK shows plain-language steps; template hashes are published per SDK release; builder addresses are pinned in the SDK; approval ceiling 3 bps |
| Replay | Duplicate orders | Hyperliquid nonce window and no agent address reuse (unique index); Lighter per-key nonces; Aster nonce window; payload-hash unique index; builds expire in 30 s; signed messages carry a one-time nonce and a short expiry |
| Delegated key stolen from the client | The attacker can trade and get the account liquidated, not withdraw to another address | Expiry, owner-signed policy (relay mode), kill switch, maker-only Lighter keys for market makers, alerts on policy breach attempts |
| Stolen Lighter API key | Beyond trading, it can force a secure withdrawal to the owner's own address and create sub-accounts | Stated openly; it still cannot transfer to another address. The owner replaces the key from the main wallet |
| Service key theft from the server | Forged receipts, spurious roots, or facilitator gas spent | Keystores (not a cloud KMS yet) under separate Unix users and env files; roots are anchored on chain and checked against the published leaf set; the facilitator float is capped; rotate by redeploying the anchor or replacing the key |
| Rate-limit abuse of the free tier | The venue budget for the relay IP is used up for everyone | Per-key, per-wallet and per-IP buckets; venue budget governor at 80%; free relay lane 2 orders per minute per wallet; heavy reads are paid |
| Sybil wallets farming the free tier | Cost | Wallet age and activity checks; paid calls above the free quota |
| Symbol mis-mapping | Spread legs on markets that are not the same thing | Human-approved equivalences only; contract-spec diff check before approval |
| Stale or divergent data | Bad quotes | Quotes refuse above 3 s of staleness; mark cross-checks against read-only feeds; stablecoin depeg flag |
| Eligibility bypass | Regulatory exposure | IP country plus a signed declaration plus agent default-deny; refusals receipted |
| Builder wallet linkage | Operational privacy breach | One builder wallet per venue; no on-chain consolidation; separate infrastructure |
| Venue changes signing or terms | Orders fail | Testnet canary per venue; feature flag per venue; signing vectors replayed in CI |
| Receipt key leak | Forged receipts | Replace the key; roots anchored on chain; old receipts stay verifiable against old roots |

## Limits we state openly
- A stolen delegated key cannot withdraw, but it can trade and get the bound account liquidated. Expiry, owner-signed
  policies and the relay kill switch reduce this. They do not remove it.
- The kill switch stops the Capstan relay. It cannot revoke a venue key; only the owner's main wallet can.
- Policy enforcement binds relay-mode traffic only. In direct mode the SDK enforces the policy, but a modified client
  could ignore it.
- Each venue liquidates independently. Capstan never nets margin across venues and cannot rescue one venue's position
  with another venue's collateral.
- Receipts prove what Capstan did, not the quality of a venue's fill.

## Scope
In scope: `apps/`, `packages/`, `contracts/src/`. Out of scope: the venues themselves (Hyperliquid, Lighter, Aster,
Variational, Arcus), Robinhood Chain, vendored libraries in `contracts/lib/`, social engineering, attacks that need a
compromised user device.
