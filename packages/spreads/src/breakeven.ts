// Breakeven of a funding-rate spread trade (at-risk): hours of the observed funding difference needed to pay the
// round-trip cost. Null when the difference is zero or negative (it never pays back at the observed rate).
export function breakevenHours(costBps: number, diffPerHourBps: number): number | null {
  if (!Number.isFinite(costBps) || !Number.isFinite(diffPerHourBps) || costBps < 0) return null;
  if (diffPerHourBps <= 0) return null;
  return costBps / diffPerHourBps;
}
