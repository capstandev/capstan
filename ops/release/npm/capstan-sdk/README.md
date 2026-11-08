# capstan-sdk

The client side of Capstan, a non-custodial perps API for Hyperliquid (core and HIP-3 markets), Lighter (mainnet and
Robinhood Chain) and Aster.

- Makes your **trade-only** venue keys on your device and keeps them there (memory, an encrypted file, or the
  browser's IndexedDB). Capstan's servers never see them, and no export of this package accepts a main-wallet key.
- Checks every payload the API builds against your intent and the pins in this release before the local key signs.
- Shows the plain-English onboarding steps before your wallet asks you to sign anything.
- Verifies receipts offline against the hourly roots anchored on Robinhood Chain.

```bash
npm install capstan-sdk
```

```ts
import { createClient, fileKeyStore, eip1193Wallet } from "capstan-sdk";

const capstan = createClient({
  apiBase: "https://api.capstan.finance",
  network: "mainnet",
  keystore: fileKeyStore("./capstan-keys.json", askPassphrase), // your own hidden prompt
  walletSigner: eip1193Wallet(window.ethereum),
});
const quote = await capstan.quote({
  canonicalAsset: "CR:BTC", side: "buy", sizeBase: "0.01", leverage: 2, holdHours: 24, orderType: "market",
});
```

## Before you trade
- Each venue liquidates your account there on its own. Margin is never pooled across venues.
- On a two-leg spread, legging risk is yours: one leg can fill and the other not.
- A trade-only key can still trade, and so can lose, the whole account it is approved for. Revoke it in the venue's
  own app when you are done (the source repository's README has the steps per venue).
- Not available in refused regions.
- Receipts prove what Capstan did, not how the venue filled.

## Verify this package
Built and published by the repository's `npm publish` workflow with npm provenance: the npm page links the exact
commit and run. The bundle is `dist/capstan-sdk.js` (dependencies inlined, names kept readable); the Lighter signer
WASM in `artifacts/` must match the sha256 pinned in the bundle or the signer refuses to start.

MIT licence.
