# Go-live kit: Lighter on Robinhood Chain (signing id 466324)

Two owner commands. Both are a dry run unless you add `--send`, and a send refuses to run unless every switch below
is set.

- `ops/golive/lighter-rh/testnet-proof.sh`: the testnet proof on market `lighter-rh:-:ETH`.
- `ops/golive/lighter-rh/mainnet-first-trade.sh`: the first tiny mainnet trade on market `lighter-rh:-:ETH`.

Run from the backend root on macOS (bash 3.2). The shared runner `ops/golive/kit.sh` puts `~/.foundry/bin` and
`~/.bun/bin` on PATH and uses `~/.foundry/bin/cast` to check `GOLIVE_OWNER`.

## What it does
1. Reads the venue's public market data (read only) and works out the smallest allowed size.
2. Opens one IOC market buy of that size through the Capstan API (relay mode by default; `--mode direct` posts to the
   venue from your machine and claims the receipt).
3. Right after, closes it with a reduce-only IOC sell sized to what filled. If the open did not fill, it sends no
   close. If the close fails or is partial it stops with `FAILED TO CLOSE` and you close the rest on the venue.
4. Receipt check (below) on both receipts.

It never withdraws, transfers or moves collateral, and it never asks for those rights.

## Dry run (default)
`ops/golive/lighter-rh/testnet-proof.sh` or `ops/golive/lighter-rh/mainnet-first-trade.sh` with no flags. It reads market data,
prints the size and every request a send would make (build, submit, receipt and proof reads) and sends none of them.
Its HTTP layer refuses every write (only GET and Hyperliquid's POST /info pass). `GOLIVE_VENUE_URL` points it at a
stand-in venue; the tests run every dry run against the fork stand-ins in `ops/fork/fake-venues.ts`.

## Arming switches
A send needs `--send` and all of these, exactly as written. The kit refuses (exit 2) and lists each one that is
missing, before it reads anything or opens the keystore.

| Switch | When | Why |
| --- | --- | --- |
| `GOLIVE_SEND=1` | always | Second lock next to `--send`. |
| `GOLIVE_CONFIRM=lighter-rh-mainnet` | mainnet only | Typed confirm: real money on a real venue. |
| `RELAY_SUBMIT_ARMED=1` | relay mode | The relay host must be armed (relay.env); unarmed it sends nothing. Set it on the host first, then in your shell. |
| `LIGHTER_EXECUTION=1` | testnet and mainnet | The API (and relay) build lighter-rh orders only with it on. Set it on the hosts first, then in your shell. |

The switches in your shell state that the hosts are armed. The hosts still enforce their own copy: an unarmed relay
or a venue flag that is off makes the API refuse the build, and nothing is sent.

Inputs a send also needs: `GOLIVE_API` (Capstan API base), `GOLIVE_KEYFILE` (the SDK file keystore holding the agent
key from onboarding), `GOLIVE_PASSPHRASE_FILE` (its passphrase, mode 600 or 400) and `GOLIVE_OWNER` (owner address).
Optional: `GOLIVE_MARKET`, `GOLIVE_MODE=direct`.

## Size
Smallest allowed, worked out at run time from the live venue data. Same rule as Lighter mainnet, read from the RH host's /api/v1/orderBookDetails. On the recorded RH book (ETH min 0.0050, min quote $10, mark 2,242.60) the minimum base size wins: 0.0050 ETH, about $11.21. Both legs use 50 bps slippage, so the
close still clears the venue minimum at the worst price it may fill.

## Receipt check
For each receipt the kit calls the SDK's verifyReceipt: the receipt signature by a Capstan receipt signer, its Merkle
proof, and the root on CapstanReceiptAnchor (46630 for testnet, 4663 for mainnet). All valid: exit 0. Signed but
the hour is not anchored yet: exit 3, and it prints `--verify <open id>,<close id>`; rerun the same command with that
after the next hourly anchor. Any other answer: exit 1. Also check by hand that the owner's Lighter RH account shows no ETH position.

## Fund first
- Testnet: USDG in the owner's Lighter RH testnet account (a separate account from Lighter 300), the Capstan API key registered by onboarding. About $15. The RH testnet host and its signing id are marked VERIFY in packages/schema (constants/venues.ts).
- Mainnet: USDG in the owner's Lighter RH account (deposited by the owner from Robinhood Chain 4663), the account made and the Capstan API key registered by onboarding. About $15. Capstan never deposits or moves it.

## Exit codes
0 done (or dry run printed), 1 failed, 2 refused (switch or input missing), 3 traded and closed, receipt anchor pending.
