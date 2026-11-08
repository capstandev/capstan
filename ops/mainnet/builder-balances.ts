// Builder balances before fee routing (todo 47 R7, DECISIONS 34). Read-only, never signs from this Mac.
//   bun ops/mainnet/builder-balances.ts [--hl 0xBUILDER] [--aster 0xBUILDER]   (defaults: the SDK mainnet pins)
// Hyperliquid (public info reads): the builder's perps account value must be at least 100 USDC and its account
// abstraction must be the standard mode ("default"). Aster: the builder must hold at least 100 ASTER in Futures and
// have its own deposit; that read is signed by the builder agent, so it runs on the VPS only (CAPSTAN_RUNNER=vps,
// through the builder-reconciler job); here it is reported as not checked. A venue whose rows are not all true stays
// fee_free_unavailable. Exit 0 when every checked row passes, 1 when one fails, 3 when nothing could be checked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { args, ROOT } from "./lib";

export const HL_INFO = "https://api.hyperliquid.xyz/info";
export const HL_MIN_USDC = 100;

export interface Row {
  venue: "hyperliquid" | "aster";
  check: string;
  state: "pass" | "fail" | "not checked";
  detail: string;
}

export async function hlRows(builder: string | null, f: typeof fetch = fetch, info = HL_INFO): Promise<Row[]> {
  if (!builder) return [{ venue: "hyperliquid", check: "builder address pinned", state: "not checked", detail: "no mainnet builder in the SDK pins yet (BACKLOG E2)" }];
  const post = async (body: unknown) => {
    const r = await f(info, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<unknown>;
  };
  const rows: Row[] = [];
  try {
    const cs = (await post({ type: "clearinghouseState", user: builder })) as { marginSummary?: { accountValue?: string } };
    const v = Number(cs.marginSummary?.accountValue ?? "NaN");
    rows.push({ venue: "hyperliquid", check: `perps account value >= ${HL_MIN_USDC} USDC`, state: Number.isFinite(v) && v >= HL_MIN_USDC ? "pass" : "fail", detail: `${Number.isFinite(v) ? v : "unreadable"} USDC` });
  } catch (e) {
    rows.push({ venue: "hyperliquid", check: `perps account value >= ${HL_MIN_USDC} USDC`, state: "not checked", detail: (e as Error).message });
  }
  try {
    const a = await post({ type: "userAbstraction", user: builder });
    rows.push({ venue: "hyperliquid", check: "standard account abstraction", state: a === "default" ? "pass" : "fail", detail: JSON.stringify(a) });
  } catch (e) {
    rows.push({ venue: "hyperliquid", check: "standard account abstraction", state: "not checked", detail: (e as Error).message });
  }
  return rows;
}

export function asterRows(builder: string | null, env: Record<string, string | undefined> = process.env): Row[] {
  if (!builder) return [{ venue: "aster", check: "builder address pinned", state: "not checked", detail: "no mainnet builder in the SDK pins yet (BACKLOG E2)" }];
  const where = env.CAPSTAN_RUNNER === "vps" ? "read it from the builder-reconciler job's aster section on this VPS" : "a signed read by the builder agent, VPS only";
  return [
    { venue: "aster", check: ">= 100 ASTER in Futures", state: "not checked", detail: where },
    { venue: "aster", check: "the builder's own deposit", state: "not checked", detail: where },
  ];
}

export const venueReady = (rows: Row[], venue: Row["venue"]) => rows.filter((r) => r.venue === venue).length > 0 && rows.filter((r) => r.venue === venue).every((r) => r.state === "pass");

if (import.meta.main) {
  const o = args(process.argv.slice(2));
  const pins = JSON.parse(readFileSync(join(ROOT, "packages/sdk/src/pins.json"), "utf8")) as { networks: { mainnet: { builders: { hyperliquid: string | null; aster: string | null } } } };
  const hl = o.hl ?? pins.networks.mainnet.builders.hyperliquid;
  const aster = o.aster ?? pins.networks.mainnet.builders.aster;
  const rows = [...(await hlRows(hl)), ...asterRows(aster)];
  console.log("| Venue | Check | State | Detail |\n|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.venue} | ${r.check} | ${r.state} | ${r.detail} |`);
  for (const v of ["hyperliquid", "aster"] as const) console.log(`${v}: ${venueReady(rows, v) ? "ready for fee routing" : "stays fee_free_unavailable"}`);
  process.exit(rows.some((r) => r.state === "fail") ? 1 : rows.every((r) => r.state === "not checked") ? 3 : 0);
}
