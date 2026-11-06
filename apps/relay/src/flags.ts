// Ops relay stop (DECISIONS #7): RELAY_ENABLED=0 stops every submit; a venue flag off stops that venue. Restart is the
// flag back on. Every change is logged with the operator and the time. Flags default to on.
import type { VenueId } from "@capstan/schema";
import { VENUE_FLAGS, type RelayFlags, type VenueFlag } from "./types";

export const FLAG_OF: Record<string, VenueFlag> = {
  hyperliquid: "HL_ENABLED",
  "lighter-mainnet": "LIGHTER_304_ENABLED",
  "lighter-rh": "LIGHTER_RH_ENABLED",
  aster: "ASTER_ENABLED",
};

export const flagOf = (v: VenueId): VenueFlag | null => FLAG_OF[v] ?? null;

const on = (v: string | undefined) => v === undefined || v === "" || v === "1" || v === "true";

export interface FlagChange {
  flag: "RELAY_ENABLED" | VenueFlag;
  value: boolean;
  operator: string;
  at: string;
}

export interface SwitchableFlags extends RelayFlags {
  set(flag: "RELAY_ENABLED" | VenueFlag, value: boolean, operator: string): FlagChange;
  changes(): FlagChange[];
}

/** Flags read from an env map at start, switchable at run time (the ops wrapper flips them and the relay logs it). */
export function relayFlags(env: Record<string, string | undefined>, o: { now?: () => number; log?: (c: FlagChange) => void } = {}): SwitchableFlags {
  const now = o.now ?? Date.now;
  const state = new Map<string, boolean>([["RELAY_ENABLED", on(env.RELAY_ENABLED)], ...VENUE_FLAGS.map((f) => [f, on(env[f])] as [string, boolean])]);
  const log: FlagChange[] = [];
  return {
    relayEnabled: () => state.get("RELAY_ENABLED") !== false,
    venueEnabled: (f) => state.get(f) !== false,
    set(flag, value, operator) {
      if (flag !== "RELAY_ENABLED" && !VENUE_FLAGS.includes(flag)) throw new Error(`unknown relay flag ${String(flag)}`);
      if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(operator)) throw new Error("operator must be a plain name");
      state.set(flag, value);
      const c: FlagChange = { flag, value, operator, at: new Date(now()).toISOString() };
      log.push(c);
      o.log?.(c);
      return c;
    },
    changes: () => [...log],
  };
}
