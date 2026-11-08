// One egress label per host (security r2 D2-ADP-06, review-r1:7 F6 and review-r1:8 R1-8-02). Venue budgets are per
// egress IP, and every governor keys its Redis buckets by this label, so every service on one host (api, relay,
// workers) must use the same one: different labels would each get their own 80% of one real IP's budget.
// CAPSTAN_EGRESS_ID is the one key; RELAY_EGRESS_ID is read only as the older name. "local" off a server.
export function egressIdOf(env: Record<string, string | undefined> = process.env): string {
  return env.CAPSTAN_EGRESS_ID?.trim() || env.RELAY_EGRESS_ID?.trim() || "local";
}
