// Recorded venue accounts through the real adapter code: Hyperliquid USER_A (core + xyz + io positions, captured
// 2026-11-06) and the Lighter-RH account fixture (HYPE short, l1 address replaced with a placeholder).
import { accountSnapshot, LIGHTER_CONFIGS, type LighterAccountRaw } from "@capstan/adapter-lighter";
import { loadFixtureRecord } from "@capstan/venue-client";
import { join } from "node:path";
import { fixtureHttp, fixtureReader, USER_A } from "../../adapters/hyperliquid/test/helpers";

export { fixtureHttp, fixtureReader, USER_A };

export const RH_OWNER = "0x00000000000000000000000000000000000A11CE" as const;

export function rhRaw(): LighterAccountRaw {
  const r = loadFixtureRecord<{ accounts: LighterAccountRaw[] }>("lighter-466324", "account", join(import.meta.dir, "../../adapters/lighter/test/fixtures")).response;
  return { ...r.accounts[0]!, l1_address: RH_OWNER };
}

export function rhSnapshot(asOf = "2026-11-01T12:00:00.000Z") {
  const raw = rhRaw();
  return accountSnapshot(LIGHTER_CONFIGS.rh, { venue: "lighter-rh", owner: RH_OWNER, accountIndex: raw.account_index ?? raw.index }, raw, asOf);
}
