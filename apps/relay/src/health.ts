// GET /health for the relay process. Three separate truths: relayEnabled (the ops stop, RELAY_ENABLED), submitArmed
// (RELAY_SUBMIT_ARMED, off unless set) and submitting (both on: the only state in which a venue is ever sent to).
import type { RelayFlags } from "./types";

export interface RelayHealth {
  ok: true;
  service: "relay";
  relayEnabled: boolean;
  submitArmed: boolean;
  submitting: boolean;
}

export function relayHealth(flags: RelayFlags): RelayHealth {
  const relayEnabled = flags.relayEnabled();
  const submitArmed = flags.submitArmed();
  return { ok: true, service: "relay", relayEnabled, submitArmed, submitting: relayEnabled && submitArmed };
}

/** The relay's own small HTTP surface: /health, everything else 404. */
export function relayHttp(flags: RelayFlags): (req: Request) => Response {
  return (req) =>
    new URL(req.url).pathname === "/health"
      ? Response.json(relayHealth(flags))
      : Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
}
