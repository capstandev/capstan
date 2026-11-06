# @capstan/signer-lighter-wasm

TypeScript wrapper around the lighter-go `wasm/` signer, pinned to lighter-go commit
`aefa96848a105d82a6bbb55d3d05663293a71713` and Go 1.26.8 (image digest in `build/common.sh`).

- `build/build.sh` rebuilds `artifacts/lighter-signer.wasm` and `artifacts/wasm_exec.js` in the pinned container and
  writes `artifacts/SHA256SUMS`. `build/build.sh --check` fails unless the rebuilt bytes equal the committed sums.
- `createLighterSigner(chainId)` starts one Worker per signing chain id (304 mainnet, 466324 Robinhood Chain, 300
  testnets). The surface is trade only: orders, cancels, key registration (ChangePubKey), zero-fee integrator
  approval and auth tokens.
- `createLighterHasher(chainId)` computes the pre-signature txHash of an order or cancel with a throwaway key, so a
  server can check a signed build without holding any user key.
- The wrapper hashes both artifacts before use and refuses to start on a mismatch.
- `build/parity.sh <vectors.json>` checks signed txs with native lighter-go code in the same container.

The `web-wasm/` build in lighter-go has no key generation export and a different call shape, so the browser bundle
uses this same `wasm/` artifact (about 3.1 MB with brotli). See `SIDECAR.md` for the documented non-WASM fallback.
