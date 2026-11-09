# Venue go-live kits

Per venue, one owner command for the testnet proof and one for the first tiny mainnet trade. Each opens the smallest
allowed size, closes it at once with a reduce-only order, and checks both receipts. Dry run by default: every
request is printed and none is sent. A send needs `--send` plus every arming switch; otherwise the kit refuses.

| Venue | Testnet proof | First mainnet trade | Venue switch |
| --- | --- | --- | --- |
| Hyperliquid core | `hl-core/testnet-proof.sh` | `hl-core/mainnet-first-trade.sh` | none |
| Hyperliquid HIP-3 | `hip3/testnet-proof.sh` | `hip3/mainnet-first-trade.sh` | `EQ_EXECUTION_ALLOWED` |
| Lighter mainnet | `lighter/testnet-proof.sh` | `lighter/mainnet-first-trade.sh` | `LIGHTER_EXECUTION` |
| Lighter RH | `lighter-rh/testnet-proof.sh` | `lighter-rh/mainnet-first-trade.sh` | `LIGHTER_EXECUTION` |
| Aster | `aster/testnet-proof.sh` | `aster/mainnet-first-trade.sh` | `ASTER_EXECUTION` |

Every send also needs `GOLIVE_SEND=1`, `RELAY_SUBMIT_ARMED=1` in relay mode, and on mainnet
`GOLIVE_CONFIRM=<venue>-mainnet`. Each venue README lists its switches, size rule, receipt check and what to fund.

Files: `kit.sh` (bash 3.2 runner, `~/.foundry/bin` on PATH), `kit.ts` (the engine), `test/kit.test.ts` (every dry run
against the fork stand-in venues, the refusals, and the send path with a stand-in SDK client).
