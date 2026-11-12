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
| Chain | Contract | Address | Sourcify |
| --- | --- | --- | --- |
| Robinhood Chain testnet (`46630`) | `CapstanReceiptAnchor` | `0x34CC7eDB6b6F17E06BF88F79dFd86D2338d86Bcf` | [verified](https://repo.sourcify.dev/46630/0x34CC7eDB6b6F17E06BF88F79dFd86D2338d86Bcf) |
| Robinhood Chain testnet (`46630`) | `CPSTLock` | `0x3D69429d628c8Ea342d5C8722c9e1A75d54Fb7DA` | [verified](https://repo.sourcify.dev/46630/0x3D69429d628c8Ea342d5C8722c9e1A75d54Fb7DA) |
| Robinhood Chain testnet (`46630`) | `CPST` | `0x32a800622317F97d829277215Bcd0D62E191EB2E` | [verified](https://repo.sourcify.dev/46630/0x32a800622317F97d829277215Bcd0D62E191EB2E) |
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
| 4 | Every routed action produces a signed receipt | `apps/relay/test/receipts.test.ts` (every submit and claim, failed submits included, gets exactly one signed receipt), `packages/receipts/test/actions.test.ts` (every receipt action type), `packages/receipts/test/pg/chain.test.ts` (receipts chain per account) (`ts` job); hourly roots posted by the anchor worker, with an alert when a post fails or falls 2 hours behind |
| 5 | Banned words never appear in docs, copy, API strings or MCP tool descriptions | `ops/ci/check-banned-words.ts` (pre-commit, `invariants` workflow) |

Contract invariants, each run for 102,400 handler calls (256 runs x depth 400, `FOUNDRY_PROFILE=ci` in the `contracts`
job) in `contracts/test/invariant/Invariants.t.sol`:

| Contract invariant | Test function |
| --- | --- |
| `CPSTLock.totalLocked` equals the sum of every `lockedOf` amount | `invariant_totalEqualsSum` |
| The lock always holds at least `totalLocked` CPST (solvent) | `invariant_solvent` |
| Every lock can be unlocked after its time, for its exact amount | `invariant_everyLockUnlockable` |
| The anchor's `latestHour` never decreases and a posted root never changes | `invariant_anchorMonotonicWriteOnce` |

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

## Accepted risks
Each row is a limit the code documents and that we keep on purpose, with the reason. The owner signs each row off
before the release that carries it; until then the row reads "pending".

| Id | Risk | Why we accept it | Owner sign-off |
| --- | --- | --- | --- |
| AR-12 | The daily lock snapshot can count the same tokens for two wallets, and many tiny locks can grow the job (`r1:0-F2`) | Needs a lock-and-move inside one block and gives only a tier perk, never funds; the job still finishes today. Fixed by update 32, New locks count within a block, release slot Day 2, +7 h | owner, 2026-11-12 |
| AR-13 | A burn plan takes its minimum output from a same-block quote with no reference price (`r1:0-F3`) | Burns are small and run by the team; the plan is reviewed before it is signed. Fixed by update 51, Burn plans check a reference rate, release slot Day 3, +2 h | owner, 2026-11-12 |
| AR-14 | The burn planner demo writes the same file as the mainnet run, and the mainnet run then exits 0 on it (`r1:0-F6`) | The planner is run by hand by the team and sends nothing by itself. Fixed by update 51, Burn plans check a reference rate, release slot Day 3, +2 h | owner, 2026-11-12 |
| AR-15 | The local agent limit counts the server's preview notional, not the checked one (`r1:1-F2`) | The relay still checks the signed order; the venue enforces margin; a stolen key is already AR-6. Fixed by update 66, Agent limits count the worst case, release slot Day 3, +17 h | owner, 2026-11-12 |
| AR-16 | Some onboarding steps are only partly checked before the wallet prompt (`r1:1-F3`) | A failed step shows up as a clear error after the prompt; no funds move in these steps. Fixed by update 50, Onboarding checks every step before you sign, release slot Day 3, +1 h | owner, 2026-11-12 |
| AR-17 | A direct-mode claim can carry a venue result the client made up (`r1:2-R1-08`) | The receipt says it is a client claim, not a Capstan relay; relay receipts are unaffected. Fixed by update 49, Receipt claims checked against the venue, release slot Day 3, +0 h | owner, 2026-11-12 |
| AR-18 | A kill is not re-checked right before the venue send, and an unreadable kill state lets agents without a policy through (`r1:2-R1-10`) | The window is one build life; agents with a policy are still stopped; the owner can revoke at the venue. Fixed by update 61, Each order build is relayed once, release slot Day 3, +12 h | owner, 2026-11-12 |
| AR-19 | One signed build can be relayed more than once because the dedupe key covers the whole body (`r1:2-R1-11`) | The venue rejects a reused nonce, so a second send fails at the venue. Fixed by update 61, Each order build is relayed once, release slot Day 3, +12 h | owner, 2026-11-12 |
| AR-20 | Policy leverage and per-order notional checks use client-declared or estimated values (`r1:2-R1-12`) | The venue enforces real margin and leverage; the policy is an extra layer. Fixed by update 66, Agent limits count the worst case, release slot Day 3, +17 h | owner, 2026-11-12 |
| AR-21 | Public and anonymous routes can grow stored data with no cap (`r1:3-F10`) | Routes are rate limited; disk is monitored and backups are sized for it. Fixed by update 68, Stored data stays bounded, release slot Day 3, +19 h | owner, 2026-11-12 |
| AR-22 | The x402 payTo env names differ between services, so the hot-key guard may check a different name (`r1:3-F11`) | The deploy checks set both names from one source; a mismatch refuses to start paid routes. Fixed by update 20, Public payment rail state, release slot Day 1, +19 h | owner, 2026-11-12 |
| AR-23 | An unused owner-signed policy could later replace a newer one (`r1:3-F13`) | Needs an old policy signature the owner already made; the owner can sign a new one at once. Fixed by update 70, The newest agent policy you signed wins, release slot Day 3, +21 h | owner, 2026-11-12 |
| AR-24 | One settled payment can unlock more than one paid answer (`r1:4-F1`) | Each answer costs $0.01 to $0.05; loss per payment is bounded and the paid routes are rate limited. Fixed by update 56, Each payment unlocks exactly one answer, release slot Day 3, +7 h | owner, 2026-11-12 |
| AR-25 | One payment authorization can claim many rows and trigger several hot-key sends (`r1:4-F3`) | The hot key holds a small float and the chain accepts one transfer per authorization. Fixed by update 56, Each payment unlocks exactly one answer, release slot Day 3, +7 h | owner, 2026-11-12 |
| AR-26 | A payer could make the Solana sponsor pay several times the route price (`r1:4-F6`) | The review marks it latent. Fixed by update 64, Payment service settles only for Capstan and recovers stuck payments, release slot Day 3, +15 h | owner, 2026-11-12 |
| AR-27 | The payment service settles any payTo it is handed, so a local process could use the hot key as a gas relay (`r1:4-F9`) | Needs code running on our own server; the hot key float is small and monitored. Fixed by update 64, Payment service settles only for Capstan and recovers stuck payments, release slot Day 3, +15 h | owner, 2026-11-12 |
| AR-28 | The reconciler can mark a pending payment dropped during an RPC outage (`r1:4-F11`) | The result is a late or repeated check, not lost funds; the payer can retry. Fixed by update 64, Payment service settles only for Capstan and recovers stuck payments, release slot Day 3, +15 h | owner, 2026-11-12 |
| AR-29 | Lighter onboarding can finish without the eligibility declaration (`r1:5-ELIG-4`) | The eligibility check still runs at order time. Fixed by update 50, Onboarding checks every step before you sign, release slot Day 3, +1 h | owner, 2026-11-12 |
| AR-30 | A tightened rule set can leave no way to get a qualifying declaration (`r1:5-ELIG-5`) | Rules do not change in the first days; the owner can reload the compiled rules. Fixed by update 65, Published eligibility rules, release slot Day 3, +16 h | owner, 2026-11-12 |
| AR-31 | Anchoring marks an hour posted after one confirmation, and a reorg is not reconciled (`r1:6-F6`) | Robinhood Chain reorgs are rare; receipts still verify off chain and the lag alert pages us. Fixed by update 60, Root indexer catches up after downtime, release slot Day 3, +11 h | owner, 2026-11-12 |
| AR-32 | The indexer rescans only from the current final block and saves its cursor only at the end of a run (`r1:6-F8`) | After downtime it can miss past roots; receipts still verify off chain and the next run recovers. Fixed by update 60, Root indexer catches up after downtime, release slot Day 3, +11 h | owner, 2026-11-12 |
| AR-33 | A receipt that lands in an already-anchored hour is never anchored (`r1:6-F9`) | Only partly fixed by its update: 87dc8f8 adds a recount alert for the last 3 anchored hours, but a late receipt is still never anchored. The receipt still verifies off chain against its signed hash. The full fix is a post-launch owner-fix update on branch fix/post-launch-f9-gw4 (DECISIONS 260). Alert update: update 16, Alert when anchoring falls behind, release slot Day 1, +15 h | owner, 2026-11-12 |
| AR-34 | Lighter order builds refuse every market until the catalog review runs (`r1:7-F10`) | Fails closed: the build is refused, so no wrong order is sent. Fixed by update 53, Lighter orders build reliably, release slot Day 3, +4 h | owner, 2026-11-12 |
| AR-35 | Lighter onboarding bundles live in one process's memory (`r1:7-F11`) | A restart loses an unfinished bundle and the user starts again; no funds are involved. Fixed by update 50, Onboarding checks every step before you sign, release slot Day 3, +1 h | owner, 2026-11-12 |
| AR-36 | An Aster account snapshot can look fresh when only another read refreshed it (`r1:7-F12`) | Risk and close-all use the venue's answer at order time; the venue is the final check. Fixed by update 44, Choose your liquidation alert distance, release slot Day 2, +19 h | owner, 2026-11-12 |
| AR-37 | Kill and close-all do not cancel resting orders, and Lighter lists open orders only for markets with a position (`r1:7-F13`) | The owner can cancel at the venue; resting orders cannot withdraw funds. Fixed by update 13, Close-all carries on past one venue and cancels resting orders, release slot Day 1, +12 h | owner, 2026-11-12 |
| AR-38 | Arcus weight budget queues callers with no deadline, so public traffic can pile up (`r1:7-F15`) | Arcus is read-only; other venues are not affected. Fixed by update 9, Per-venue status endpoint, release slot Day 1, +8 h | owner, 2026-11-12 |
| AR-39 | Liquidation alerts stop for owners with no order in 30 days, and failed venue reads raise nothing (`r1:8-R1-8-07`) | Alerts are a courtesy and say so; the venue's own liquidation rules apply. Fixed by update 44, Choose your liquidation alert distance, release slot Day 2, +19 h | owner, 2026-11-12 |
| AR-40 | The paid liquidation heatmap counts positions several times and loads up to 2,000 risk views per call (`r1:8-R1-8-08`) | The price is $0.02 per call and routes are rate limited; the numbers are marked estimates. Fixed by update 48, Liquidation heatmap bucket size, release slot Day 2, +23 h | owner, 2026-11-12 |
| AR-41 | User alert webhooks cannot work on the provisioned server (`r1:8-R1-8-11`) | The feature is optional; it fails visibly and no alert is sent. Fixed by update 41, Send a test event to your webhook, release slot Day 2, +16 h | owner, 2026-11-12 |
| AR-42 | The executor can keep trading after its event posts fail, so a re-run of an acked plan can send leg A again (`r1:8-R1-8-13`) | The executor is a team tool run by hand and each leg is a normal receipted order. Fixed by update 54, SDK watch helpers for live channels, release slot Day 3, +5 h | owner, 2026-11-12 |
| AR-43 | Paid MCP tools do the work before settlement, so one $0.01 authorization can buy many parallel runs (`r1:9-F-6`) | Cost per run is small and the MCP server is rate limited. Fixed by update 42, MCP rate limit per caller, release slot Day 2, +17 h | owner, 2026-11-12 |
| AR-44 | The order ticket shows server preview fields under 'SDK check passed' (`r1:9-F-8`) | The relay and the venue check the real order; the preview is only a preview. Fixed by update 66, Agent limits count the worst case, release slot Day 3, +17 h | owner, 2026-11-12 |
| AR-45 | A receipt can read valid on server assertions alone (`r1:9-F-10`) | The receipt hash and signature still verify with the public key, off chain. Fixed by update 46, Receipt checks in plain words, release slot Day 2, +21 h | owner, 2026-11-12 |
| AR-46 | SECURITY.md left out the dashboard and ops, accepted risks, audit history and a stale-input table (`r1:9-F-11`) | Update 67 adds all of them; this list is part of that fix. Fixed by update 67, Security policy covers the whole stack, release slot Day 3, +18 h | owner, 2026-11-12 |
| AR-47 | Close-all build checks eligibility for one venue while it builds for every active venue (`r2-R2-GW-2`) | Each venue is gated again at order time. Fixed by update 13, Close-all carries on past one venue and cancels resting orders, release slot Day 1, +12 h | owner, 2026-11-12 |
| AR-48 | Top-up credit across accounts is a non-locking check, so two writers could credit twice (`r2-R2-GW-3`) | Amounts are small and the reconcile job flags a double credit. Fixed by update 56, Each payment unlocks exactly one answer, release slot Day 3, +7 h | owner, 2026-11-12 |
| AR-49 | The pre-auth failure bucket is per shared IP and not atomic, so bursts pass the cap and bad requests can lock out others (`r2-R2-GW-4`) | Only partly fixed by its update: 5bb0073 makes the pre-auth take atomic, but one shared IP can still lock out signed writes. It is throttling only and no data is exposed. The full fix is a post-launch owner-fix update on branch fix/post-launch-f9-gw4 (DECISIONS 260). Partial fix: update 5, Rate-limit headers on every answer, release slot Day 1, +4 h | owner, 2026-11-12 |
| AR-50 | A pending settle on a priced data route still charges the payer and withholds the answer (`r2-R2-GW-6`) | The payer can retry and the charge is $0.05 at most. Fixed by update 64, Payment service settles only for Capstan and recovers stuck payments, release slot Day 3, +15 h | owner, 2026-11-12 |
| AR-51 | The relay advisory lock waits while holding a pooled connection, so the pool can run dry (`r2-R2-RELAY-04`) | Shows as slower relays, not wrong orders; the pool is monitored. Fixed by update 61, Each order build is relayed once, release slot Day 3, +12 h | owner, 2026-11-12 |
| AR-52 | The exit deadline does not cover dispatcher wait time, so a safety job can go out after its payload expired (`r2-R2-RELAY-05`) | The venue rejects an expired payload. Fixed by update 61, Each order build is relayed once, release slot Day 3, +12 h | owner, 2026-11-12 |
| AR-53 | Attacker-minted refusals can keep the open-hour rebuild running (`r2-R2-RELAY-06`) | Costs server time only and routes are rate limited. Fixed by update 33, Download all your receipts, release slot Day 2, +8 h | owner, 2026-11-12 |
| AR-54 | An owner with several Lighter accounts can get another account's positions as the gross base (`r2-R2-RELAY-07`) | Affects the owner's own limits only. Fixed by update 66, Agent limits count the worst case, release slot Day 3, +17 h | owner, 2026-11-12 |
| AR-55 | A throw after the atomic append can leave a stored step with no receipt (`r2-R2-SPREADS-02`) | The step is stored and a re-run issues the receipt; nothing is sent twice. Fixed by update 54, SDK watch helpers for live channels, release slot Day 3, +5 h | owner, 2026-11-12 |
| AR-56 | Sybil wallets with slow failing hooks can delay other owners' webhook delivery (`r2-R2-SPREADS-03`) | Delays only; no data leaves. Fixed by update 45, Webhook delivery log, release slot Day 2, +20 h | owner, 2026-11-12 |
| AR-57 | Server-chosen HL agent name and Lighter API key index can overwrite the user's other agents and keys (`r1:1-F4`) | The overwrite needs a build the owner still signs in the wallet prompt; the owner can re-add the agent or key. Fixed by update 10, SDK keeps your agents after a page reload, release slot Day 1, +9 h | owner, 2026-11-12 |
| AR-58 | HL reconciler starves the same owners every day, drops fills at page boundaries and never retries failed owners (`r1:5-RECON-2`) | The reconciler is a cross-check of builder fees; it does not touch orders or funds. Fixed by update 24, Builder fee reconciliation metric, release slot Day 1, +23 h | owner, 2026-11-12 |
| AR-59 | A corrupt or 5xx builder CSV aborts the whole cross-check and loses that day's check (`r1:5-RECON-3`) | Only that day's cross-check is lost; trading and receipts are unaffected. Fixed by update 24, Builder fee reconciliation metric, release slot Day 1, +23 h | owner, 2026-11-12 |
| AR-60 | Funding forecast serves a days-old rate as a current forecast with no freshness field (`r1:8-R1-8-09`) | Funding data older than 2 h already refuses a quote with a hold time (STALE-1); the forecast is advisory. Fixed by update 28, Quotes use the funding forecast when it is fresh, release slot Day 2, +3 h | owner, 2026-11-12 |
| AR-61 | One malformed market aborts the whole spread-scan and forecaster pass (`r1:8-R1-8-10`) | Fails visibly and only for that pass; no order is affected. Fixed by update 12, Spread scan says why a pair was left out, release slot Day 1, +11 h | owner, 2026-11-12 |
| AR-62 | Every service shares one Postgres superuser and an unauthenticated Redis, so one compromised internet-facing service reaches kill flags and delegation data (`r1:9-F-2`) | Both stores bind to 127.0.0.1 and the firewall allows only 22, 80 and 443 (see the shared state stores threat row); keys are never stored server side. Fixed by update 27, Each service gets its own database login, release slot Day 2, +2 h | owner, 2026-11-12 |
| AR-63 | A transient RPC error at the first paid call drops that x402 rail until the process restarts (`r1:9-F-7`) | Fails closed: the rail is off, not free; a restart restores it. Fixed by update 20, Public payment rail state, release slot Day 1, +19 h | owner, 2026-11-12 |

## Scope
In scope: `apps/`, `packages/`, `contracts/src/`. Out of scope: the venues themselves (Hyperliquid, Lighter, Aster,
Variational, Arcus), Robinhood Chain, vendored libraries in `contracts/lib/`, social engineering, attacks that need a
compromised user device.
