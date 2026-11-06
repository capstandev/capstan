# Lighter signer sidecar (documented fallback, not built)

The WASM signer in this package runs in Bun, Node and browsers well under the 50 ms per signature budget
(about 2 to 3 ms p50 through the Worker), so no sidecar ships. This page records the fallback for a runtime that
cannot run WASM (for example a locked-down host).

## Shape

- A small Go binary built from the same pinned lighter-go commit (`aefa96848a105d82a6bbb55d3d05663293a71713`), in
  the same pinned golang container as `build/build.sh`.
- Listens on `127.0.0.1` only, on a port the user picks. Never on `0.0.0.0`, never behind a proxy.
- Every request carries `Authorization: Bearer <token>`. The token is 32 random bytes written to a local file with
  mode 0600 at first start; the client reads the same file. A request without it gets 401.
- Endpoints mirror the WASM wrapper and nothing more: `/sign/createOrder`, `/sign/cancelOrder`,
  `/sign/cancelAll`, `/sign/changePubKey`, `/sign/approveIntegrator` (zero fees only), `/authToken`. JSON in and out
  with the same fields (`txType`, `txInfo`, `txHash`, `messageToSign`). Every call needs an explicit nonce.
- No transfer, withdraw, sub-account, pool, stake or margin endpoint, same rule as the wrapper.
- The API key lives in an encrypted keystore on the user's own machine and is never sent anywhere.

## Where it may run

On the user's own machine (a bot host the user controls). Never on any Capstan server: signing never moves
server side.
