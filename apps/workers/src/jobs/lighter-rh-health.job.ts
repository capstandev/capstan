// Nightly Lighter-RH deposit contract check (00:45 UTC): GET /info must name the pinned contract and its EIP-1967
// implementation slot must hold the pinned implementation. A mismatch is an ops alert; deposit builds already refuse
// on their own boot check (fail closed). Only reviewed pin updates in constants move the pin.
import { bootCheck, lighterReaderFor, LIGHTER_CONFIGS, rhcSlotReader, type BootResult, type SlotReader } from "@capstan/adapter-lighter";
import type { JobDef, JobDeps } from "@capstan/core";
import { egressIdOf, createMemoryGovernor, createGovernor } from "@capstan/venue-client";

export const OPS_ALERT_CHANNEL = "ops.alert";

export async function runRhHealth(deps: JobDeps, o: { reader?: Parameters<typeof bootCheck>[0]; rpc?: SlotReader } = {}): Promise<BootResult> {
  const egress = egressIdOf(process.env); // one label per host (D2-ADP-06)
  const gov = deps.redis ? createGovernor(deps.redis, egress) : createMemoryGovernor(egress);
  const reader = o.reader ?? lighterReaderFor(LIGHTER_CONFIGS.rh, gov, deps.cache);
  const r = await bootCheck(reader, o.rpc ?? rhcSlotReader());
  if (r.ok) deps.log.info("lighter-rh deposit pin ok", { contract: r.contract, implementation: r.implementation });
  else {
    const alert = { kind: "lighter_rh.deposit_pin_mismatch", detail: { reason: r.reason, contract: r.contract ?? null, implementation: r.implementation ?? null } };
    if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, alert);
    else deps.log.warn("ops alert", alert);
  }
  return r;
}

export const job: JobDef = {
  name: "lighter-rh-health",
  queue: "reconcileDaily",
  schedule: { pattern: "45 0 * * *" },
  concurrency: 1,
  handler: (_job, deps) => runRhHealth(deps),
};
