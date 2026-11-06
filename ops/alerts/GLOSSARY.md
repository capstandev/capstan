# Ops alert glossary

Every ops alert names one cause from this file. Each entry says what it means and what to do. The `ops-alerts` worker
refuses to start if code uses a cause that is not listed here. Alerts only notify: none of them stops, pauses or
kills anything. Stopping the relay is a person's decision (see the relay-stop runbook).

Severity: `info` = note it; `act` = someone acts today; `critical` = act now, consider stopping the relay.

## anchor.hour_unpostable
Severity: critical
Means: an hour's receipt root can never be posted, because a later hour is already on chain (roots only move forward).
Do: find why the hour was skipped (worker down, RPC errors); its receipts stay valid off chain but have no anchor.

## anchor.poster_low_balance
Severity: act
Means: the anchor poster's gas balance on Robinhood Chain is below the configured minimum.
Do: the owner funds the poster address with the amount in the alert; posting continues while funds remain.

## anchor.root_mismatch
Severity: critical
Means: a root read back from the anchor contract differs from the root Capstan computed for that hour.
Do: stop the relay, compare the two roots and the receipts of that hour, follow the incident runbook.

## anchor.root_event_mismatch
Severity: critical
Means: an on-chain root event does not match the stored root for the same hour.
Do: same as anchor.root_mismatch.

## backup.failed
Severity: act
Means: the daily encrypted database backup did not finish.
Do: read the backup unit log on the server and run the backup again by hand.

## builder.aster_low
Severity: act
Means: the Aster builder wallet holds less than 100 ASTER in Futures. Aster stops paying builder fees below it.
Do: the owner tops up the Aster builder wallet to at least 100 ASTER in Futures.

## builder.hl_low
Severity: act
Means: the Hyperliquid builder account value is below 100 USDC. Hyperliquid stops builder fees below it.
Do: the owner moves USDC into the builder's perps account until it is at least 100.

## builder.hl_not_standard
Severity: act
Means: the Hyperliquid builder account is not in the standard account abstraction mode, which builder fees need.
Do: the owner switches the builder account back to the standard mode in the builder wallet.

## builder.read_failed
Severity: info
Means: a builder balance read failed (venue API error). Nothing changed on our side.
Do: nothing if the next read works; check the venue status if it repeats.

## catalog.new_dexes
Severity: info
Means: the nightly catalog sync found new venue dexes. They start non-executable.
Do: a reviewer looks at them in working hours before any market is turned on.

## catalog.reduce_only
Severity: act
Means: markets were set to reduce-only because their dex or market is gone at the venue.
Do: check the venue's announcement; users can still close positions.

## catalog.source_errors
Severity: act
Means: one or more catalog sources failed during the nightly sync; their markets were left as they were.
Do: read the error, fix the source or wait for the venue, run the sync again.

## deploy.rollback
Severity: critical
Means: a deploy failed its health checks and the server rolled back to the previous release.
Do: read the deploy log, fix the release in the private repo, deploy again.

## gas.low
Severity: act
Means: a service key (facilitator or another sender) has less gas than its configured minimum.
Do: the owner sends the amount in the alert to the address in the alert.

## geo.refresh_failed
Severity: info
Means: the weekly DB-IP Lite country file refresh failed. The previous file stays in use for eligibility.
Do: nothing if next week's run works; if it repeats, check the DB-IP download page and the server's disk space.

## governor.above_90
Severity: act
Means: a venue request budget on one egress IP is above 90% of the venue limit. Above 100% the venue starts refusing.
Do: look for one client using most of it; free-lane users get the direct-mode hint; consider raising the venue tier.

## lighter_rh.deposit_pin_mismatch
Severity: critical
Means: the Lighter on Robinhood Chain deposit contract or its implementation no longer matches the pinned address.
Deposit builds already refuse on their own.
Do: read the new implementation, decide whether it is safe, and only then update the pin by a reviewed change.

## ops.unknown_event
Severity: act
Means: a service sent an ops event whose kind this file does not know.
Do: add the cause to this glossary and to the cause table, or fix the sender.

## ops.unparseable
Severity: act
Means: a message on the ops alert channel was not a valid event (not JSON, or no kind).
Do: find the sender from the time and fix its message format.

## quote.stale_t1
Severity: act
Means: quotes for a tier-one venue have been older than 3 seconds for 5 minutes. Quotes for that venue are refused.
Do: check the venue's websocket ingest and the venue status page.

## quote.stale_t1_recovered
Severity: info
Means: quotes for that venue are fresh again.
Do: nothing.

## reconciler.mismatch
Severity: act
Means: the daily builder-fee reconciliation found fills or fees that do not match Capstan's orders.
Do: read the day's unmatched fills; a large count can mean a builder field is used outside Capstan.

## x402.float_above_limit
Severity: act
Means: the facilitator hot key holds more than the float limit (200 USD).
Do: the owner runs the sweep command printed in the alert to move the extra to the brand Safe.

## x402.eip3009_absent
Severity: act
Means: the daily check no longer finds EIP-3009 on a USDG or USDC rail, so that rail stops offering it.
Do: nothing breaks (Permit2 stays the default); read the token's new code before turning EIP-3009 back on.

## x402.rail_dropped
Severity: act
Means: a payment rail was left out of the 402 offers because one settle would cost more than half of the smallest price, or its cost is unknown.
Do: check the chain's gas price; the rail comes back by itself at the next boot check when costs fall.

## x402.settle_dropped
Severity: act
Means: a submitted x402 settlement was never seen on chain and was marked dropped.
Do: check the facilitator key's gas and nonce; the payer was not charged for that call.

## x402.token_facts_failed
Severity: act
Means: the facilitator could not read a payment token's facts (name, decimals, domain) at boot, so that rail is off.
Do: check the RPC; restart the facilitator once the RPC answers.

