// Facilitator float guard (DECISIONS #45): the hot key holds gas only, and the dollar tokens collected at the hot key
// or at a sweep address may never exceed $200. Above the limit an ops alert is raised and the sweep runbook command
// is PRINTED for the owner to run; this module never builds, signs or sends a transaction.
import type { Logger } from "@capstan/core";

export const FLOAT_MAX_USD = 200;

export interface FloatHolding {
  network: string;
  asset: string;
  /** Address that holds the funds (the hot key or a sweep address). */
  holder: string;
  atomic: bigint;
  decimals: number;
}

export interface FloatAlert {
  kind: "x402.float_above_limit";
  totalUsd: number;
  limitUsd: number;
  holdings: { network: string; asset: string; holder: string; usd: number }[];
  sweepCommands: string[];
}

export interface FloatGuardOptions {
  maxUsd?: number;
  holdings: () => Promise<FloatHolding[]>;
  /** Where sweeps go (the brand Safe). */
  sweepTo: string;
  alert: (a: FloatAlert) => Promise<void> | void;
  log: Logger;
}

const toUsd = (atomic: bigint, decimals: number): number => Number(atomic) / 10 ** decimals;

/** The owner's sweep command for one holding (printed, never executed). */
export function sweepCommand(h: FloatHolding, sweepTo: string): string {
  if (h.network.startsWith("solana:")) {
    return `spl-token transfer ${h.asset} ${toUsd(h.atomic, h.decimals)} ${sweepTo} --owner <sponsor keypair path> --url <solana rpc>   # run by the owner, see runbooks/facilitator-sweep.md`;
  }
  return `~/.foundry/bin/cast send ${h.asset} 'transfer(address,uint256)' ${sweepTo} ${h.atomic} --rpc-url <${h.network} rpc> --keystore <hot key keystore path>   # run by the owner, see runbooks/facilitator-sweep.md`;
}

export function floatGuard(o: FloatGuardOptions) {
  const limit = o.maxUsd ?? FLOAT_MAX_USD;
  return {
    limitUsd: limit,
    /** Check the float, counting `incoming` (a settle about to land on a guarded holder). */
    async check(incoming: FloatHolding[] = []): Promise<{ totalUsd: number; over: boolean; alert?: FloatAlert }> {
      let held: FloatHolding[];
      try {
        held = await o.holdings();
      } catch (err) {
        o.log.warn("float check failed", { err });
        return { totalUsd: Number.NaN, over: false };
      }
      const all = [...held, ...incoming];
      const totalUsd = all.reduce((s, h) => s + toUsd(h.atomic, h.decimals), 0);
      if (totalUsd <= limit) return { totalUsd, over: false };
      const alert: FloatAlert = {
        kind: "x402.float_above_limit",
        totalUsd,
        limitUsd: limit,
        holdings: all.map((h) => ({ network: h.network, asset: h.asset, holder: h.holder, usd: toUsd(h.atomic, h.decimals) })),
        sweepCommands: held.filter((h) => h.atomic > 0n).map((h) => sweepCommand(h, o.sweepTo)),
      };
      o.log.warn("facilitator float above limit: owner sweep needed", { totalUsd, limitUsd: limit });
      for (const cmd of alert.sweepCommands) o.log.warn("sweep command (owner runs it)", { cmd });
      await o.alert(alert);
      return { totalUsd, over: true, alert };
    },
  };
}
