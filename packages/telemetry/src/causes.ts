// Ops events -> plain ops alerts. Services publish `{ kind, severity?, detail?, ... }` on the `ops.alert` channel
// (catalog-sync, anchor, root-indexer, lighter-rh-health, the x402 float guard, and the monitors in this package).
// Each known kind maps to one glossary cause and the four plain parts: what happened, who is affected, what was done,
// what is next. An unknown kind becomes `ops.unknown_event` instead of being dropped.
import { loadGlossary, type GlossaryEntry, type Severity } from "./glossary";

export interface OpsAlert {
  cause: string;
  severity: Severity;
  what: string;
  affected: string;
  done: string;
  next: string;
}

export interface OpsEvent {
  kind: string;
  severity?: string;
  detail?: unknown;
  [k: string]: unknown;
}

const NOTHING_DONE = "Nothing was changed automatically; alerts only notify.";

interface CauseSpec {
  affected: string;
  done?: string;
  /** Extra facts for the "what" line, from the event. */
  facts?: (e: OpsEvent) => string;
}

const count = (v: unknown) => (Array.isArray(v) ? v.length : v === undefined ? 0 : 1);

/** Every cause the code can raise. The ops-alerts worker checks this list against the glossary at start. */
export const CAUSES: Record<string, CauseSpec> = {
  "anchor.hour_unpostable": { affected: "Receipts of that hour have no on-chain root; users are not otherwise affected.", facts: (e) => `hour ${field(e, "hourEpoch")}, latest on chain ${field(e, "latestOnChain")}` },
  "anchor.poster_low_balance": { affected: "No users yet; posting stops when the gas runs out.", done: "Posting continues while funds remain.", facts: (e) => `balance ${field(e, "balanceWei")} wei, minimum ${field(e, "minWei")} wei, poster ${field(e, "poster")}` },
  "anchor.post_failed": { affected: "Receipts of that hour have no on-chain root yet; they still verify off chain.", done: "The nonce was resynced; the next hourly run retries the same hour.", facts: (e) => `hour ${field(e, "hourEpoch")}: ${field(e, "error")}` },
  "anchor.lagging": { affected: "Recent receipts have no on-chain root; they still verify off chain.", facts: (e) => `oldest unanchored hour ${field(e, "oldestUnanchored")}, ${field(e, "hoursBehind")} hours behind, latest recorded ${field(e, "latestRecorded")}` },
  "anchor.root_mismatch": { affected: "Receipt proofs for that hour may not verify.", facts: (e) => `hour ${field(e, "hourEpoch")}` },
  "anchor.root_event_mismatch": { affected: "Receipt proofs for that hour may not verify.", facts: (e) => `hour ${field(e, "hourEpoch")}` },
  "backup.failed": { affected: "No users; the last good backup is older than a day.", facts: (e) => `step ${field(e, "step")}` },
  "builder.aster_low": { affected: "Aster orders may carry no builder fee until topped up.", facts: (e) => `balance ${field(e, "balance")} ASTER, minimum ${field(e, "minimum")}` },
  "builder.hl_low": { affected: "Hyperliquid orders may carry no builder fee until topped up.", facts: (e) => `account value ${field(e, "accountValue")} USDC, minimum ${field(e, "minimum")}` },
  "builder.hl_not_standard": { affected: "Hyperliquid builder fees may stop.", facts: (e) => `mode ${field(e, "mode")}` },
  "builder.read_failed": { affected: "No users.", facts: (e) => `venue ${field(e, "venue")}, error ${field(e, "error")}` },
  "catalog.new_dexes": { affected: "No users: new dexes start non-executable.", facts: (e) => `${count(e.detail)} new` },
  "catalog.reduce_only": { affected: "Users with positions there can only reduce them.", done: "Markets were set to reduce-only by the catalog sync.", facts: (e) => `${count(e.detail)} markets` },
  "catalog.source_errors": { affected: "Markets from those sources were left unchanged.", facts: (e) => `${count(e.detail)} sources` },
  "deploy.rollback": { affected: "The previous release is serving; the new one is not live.", done: "The server rolled back to the previous release.", facts: (e) => `failed ${field(e, "sha")}, now ${field(e, "previous")}` },
  "gas.low": { affected: "That service stops sending when the gas runs out.", facts: (e) => `${field(e, "service")} balance ${field(e, "balance")}, minimum ${field(e, "minimum")}` },
  "geo.refresh_failed": { affected: "No users: eligibility keeps using the previous DB-IP file.", facts: (e) => `month ${field(e, "month")}, reason ${field(e, "reason")}` },
  "governor.above_90": { affected: "All users of that venue on this IP; above 100% the venue refuses requests.", facts: (e) => `${field(e, "budget")} at ${field(e, "usedPct")}%` },
  "lighter_rh.deposit_pin_mismatch": { affected: "Lighter on Robinhood Chain deposit builds are refused until reviewed.", done: "Deposit builds refuse on their own boot check (fail closed).", facts: (e) => `reason ${field(e, "reason")}` },
  "ops.unknown_event": { affected: "Unknown.", facts: (e) => `kind ${field(e, "unknownKind")}` },
  "ops.unparseable": { affected: "Unknown.", facts: (e) => `length ${field(e, "length")}` },
  "quote.stale_t1": { affected: "Quotes and builds for that venue are refused.", done: "Quotes refuse stale data on their own (3 s guard).", facts: (e) => `${field(e, "venue")} stale ${field(e, "staleMs")} ms for ${field(e, "forMinutes")} min` },
  "quote.stale_t1_recovered": { affected: "No longer.", facts: (e) => `${field(e, "venue")} fresh again` },
  "reconciler.mismatch": { affected: "Fee reports for that day may be wrong.", facts: (e) => `day ${field(e, "day")}, ${field(e, "unmatchedFills")} unmatched fills` },
  "spreads.event_mismatch": { affected: "One spread plan's reported fill may be wrong; the owner's residual may differ.", facts: (e) => `plan ${field(e, "planId")}, ${field(e, "eventKind")} reported ${field(e, "reported")}, venue read ${field(e, "venueRead")}` },
  "spreads.market_changed": { affected: "That pair is left out of the spread scan until reviewed again.", done: "The scan dropped the pair on its own.", facts: (e) => `equivalence ${field(e, "equivalenceId")}, ${field(e, "a")} vs ${field(e, "b")}` },
  "x402.eip3009_absent": { affected: "Payers on that rail use Permit2 instead.", done: "The rail stopped offering EIP-3009 on its own.", facts: (e) => `chain ${field(e, "chain")}, reason ${field(e, "reason")}` },
  "x402.rail_dropped": { affected: "Payers cannot use that rail until costs fall.", done: "The rail was left out of the 402 offers.", facts: (e) => `rail ${field(e, "rail")}, cost ${field(e, "costUsd")} USD, limit ${field(e, "limitUsd")} USD` },
  "x402.settle_dropped": { affected: "One payer's call was not charged.", done: "The settlement was marked dropped.", facts: (e) => `chain ${field(e, "chain")}` },
  "x402.token_facts_failed": { affected: "Payers cannot use that rail.", done: "The rail stayed off.", facts: (e) => `rail ${field(e, "rail")}` },
  "x402.float_above_limit": { affected: "No users; more than the float limit sits on a hot key.", facts: (e) => `total ${field(e, "totalUsd")} USD, limit ${field(e, "limitUsd")} USD, ${count(e.sweepCommands)} sweep commands in the facilitator log` },
};

/** Event kinds that are spelled differently from the cause they raise. */
const KIND_ALIASES: Record<string, string> = {};

function field(e: OpsEvent, k: string): string {
  const d = (e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : {}) as Record<string, unknown>;
  const v = k in d ? d[k] : e[k];
  if (v === undefined || v === null) return "n/a";
  return typeof v === "string" ? v : JSON.stringify(v);
}

const RANK: Record<Severity, number> = { info: 0, act: 1, critical: 2 };
function producerSeverity(s: unknown): Severity | null {
  if (s === "critical") return "critical";
  if (s === "warning" || s === "warn" || s === "act" || s === "error") return "act";
  if (s === "info") return "info";
  return null;
}

/** Map an event to its alert. The severity is the higher of the glossary's and the producer's. */
export function toOpsAlert(e: OpsEvent, glossary: Map<string, GlossaryEntry> = loadGlossary()): OpsAlert {
  let cause = KIND_ALIASES[e.kind] ?? e.kind;
  let ev = e;
  if (!CAUSES[cause] || !glossary.has(cause)) {
    ev = { kind: "ops.unknown_event", detail: { unknownKind: e.kind } };
    cause = "ops.unknown_event";
  }
  const g = glossary.get(cause)!;
  const spec = CAUSES[cause]!;
  const p = producerSeverity(e.severity);
  const severity = p && RANK[p] > RANK[g.severity] ? p : g.severity;
  const facts = spec.facts ? spec.facts(ev) : "";
  return {
    cause,
    severity,
    what: facts ? `${g.means} (${facts})` : g.means,
    affected: spec.affected,
    done: spec.done ?? NOTHING_DONE,
    next: g.todo,
  };
}
