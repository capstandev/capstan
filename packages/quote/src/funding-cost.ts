// Funding cost over the hold (R7). Every stored rate means "longs pay when positive", so a long pays +rate and a short
// pays -rate: cost(buy) == -cost(sell) exactly. Funding is observed and changes hourly; it is never a promise.
import { Dec } from "@capstan/schema";
import { BPS, d, toBps } from "./dec";

export const FUNDING_NOTE = "Funding is observed and changes hourly." as const;

export function fundingCostBps(ratePerHour: string, holdHours: number, side: "buy" | "sell"): number {
  if (!Number.isFinite(holdHours) || holdHours < 0) throw new RangeError("holdHours must be a finite number >= 0");
  if (holdHours === 0) return 0;
  const raw = Dec.mul(Dec.mul(d(ratePerHour), Dec.parse(String(holdHours), 12, "half_even"), 30), BPS, 30);
  // round the magnitude once (half-even), then apply the side: symmetric by construction
  const mag = toBps(Dec.abs(raw));
  const signed = Dec.cmp(raw, Dec.parse("0", 0)) < 0 ? -mag : mag;
  const v = side === "buy" ? signed : -signed;
  return v === 0 ? 0 : v;
}
