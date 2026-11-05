# Security policy

## Reporting a vulnerability
Please report privately through GitHub's private vulnerability reporting on this repository ("Security" tab, "Report
a vulnerability"). Include the affected package, service or contract and steps or a proof of concept (a failing
test is ideal). Do not open a public issue and do not test against live venues with real funds. We aim to reply
within 72 hours and to share a fix plan within 7 days. There is no paid reward programme yet.

## Status
Pre-release. Nothing is deployed. The code has not had an external audit.

## Design rules that reports can hold us to
- **No user keys, ever.** No service accepts, stores, logs or imports a user private key, seed or mnemonic. CI fails
  on any such identifier in `apps/`. Only the client-side SDK (`packages/sdk`) holds the delegated trading key, on
  the user's own device or host.
- **Trade-only delegation.** No venue authorization asks for withdraw or transfer permission. Every adapter declares
  `canWithdraw: false` as a type-level literal.
- **No cross-venue margin.** Collateral stays siloed per venue and per chain; the schema has no object that pools collateral across venues.
- **Every routed action gets a signed receipt.** Receipts are chained per account and their hourly Merkle roots are
  posted to `CapstanReceiptAnchor` on Robinhood Chain.
- The SDK checks every built payload against the user's intent before signing. A tampered payload fails at the venue.

## Limits we state openly
- A stolen delegated key cannot withdraw, but it can trade and get the bound account liquidated. Expiry, owner-signed
  policies and the relay kill switch reduce this. They do not remove it.
- The kill switch stops the Capstan relay. It cannot revoke a venue key; only the owner's main wallet can.

## Scope
In scope: `apps/`, `packages/`, `contracts/src/`. Out of scope: the venues themselves (Hyperliquid, Lighter, Aster,
Variational, Arcus), Robinhood Chain, vendored libraries in `contracts/lib/`, social engineering, attacks that need a
compromised user device.
