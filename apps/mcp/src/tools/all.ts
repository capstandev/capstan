// All seventeen tools of spec 13.3, in the spec's order.
import { capstan_build_order, capstan_markets, capstan_positions, capstan_quote, capstan_submit } from "./core";
import { capstan_cancel_build, capstan_eligibility, capstan_funding, capstan_get_receipt, capstan_kill, capstan_onboarding_build, capstan_plan_status, capstan_risk_v2, capstan_set_policy, capstan_spread_plan, capstan_spread_scan, capstan_verify_receipt } from "./more";
import type { ToolDef } from "./types";

export function allTools(): ToolDef[] {
  return [capstan_markets, capstan_funding, capstan_quote, capstan_onboarding_build, capstan_build_order, capstan_submit, capstan_cancel_build, capstan_positions, capstan_risk_v2, capstan_spread_scan, capstan_spread_plan, capstan_plan_status, capstan_set_policy, capstan_kill, capstan_get_receipt, capstan_verify_receipt, capstan_eligibility];
}
