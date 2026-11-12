// The demo clip list for the marketing kit, one entry per clip in the shot list (the private marketing folder's
// videos/SCRIPT.md: "## Clip 0" and the numbered "## Kit clips"). Every clip in the script has an entry here: either
// recorded on the fork stack, or held with the reason it cannot be recorded honestly today.
export type Device = "desktop" | "phone";

export interface Clip {
  /** The clip number in the script ("0" is the overview). */
  script: string;
  /** Output name stem: <name>-<device>.mp4 */
  name: string;
  title: string;
  devices: Device[];
  /** "fork": recorded on ops/fork/up.sh. "held": not recorded; `reason` says why. */
  source: "fork" | "held";
  reason?: string;
  /** Upper bound in seconds (the script's length, never above 59). */
  maxSeconds: number;
}

export const CLIPS: Clip[] = [
  { script: "0", name: "00-overview", title: "Overview", devices: ["desktop", "phone"], source: "fork", maxSeconds: 32 },
  { script: "1", name: "01-quote-compare", title: "Quote compare", devices: ["desktop", "phone"], source: "fork", maxSeconds: 30 },
  { script: "2", name: "02-onboard-hyperliquid", title: "Onboarding: Hyperliquid", devices: ["desktop"], source: "fork", maxSeconds: 40 },
  { script: "2", name: "02-onboard-lighter", title: "Onboarding: Lighter", devices: ["desktop"], source: "held", reason: "Lighter execution is off on the fork stack (/v1/venues says execution false), so there is no honest onboarding to film", maxSeconds: 40 },
  { script: "2", name: "02-onboard-aster", title: "Onboarding: Aster", devices: ["desktop"], source: "held", reason: "the fork stack has no Aster stand-in venue, so the bundle cannot be fetched on the fork", maxSeconds: 40 },
  { script: "3", name: "03-risk-panel", title: "Risk panel", devices: ["desktop"], source: "fork", maxSeconds: 30 },
  { script: "4", name: "04-spread-plan", title: "Spread plan", devices: ["desktop"], source: "held", reason: "a spread needs two venues that execute; on the fork stack only Hyperliquid executes (Lighter stand-ins have execution off)", maxSeconds: 45 },
  { script: "5", name: "05-kill-switch", title: "Kill switch (the policy half is held: agent-safe onboarding answered 500 on the fork)", devices: ["desktop"], source: "fork", maxSeconds: 40 },
  { script: "6", name: "06-mcp", title: "MCP agent client", devices: ["desktop"], source: "held", reason: "the hosted MCP endpoint and its landing page are not live (D1, D4); the site has no client view to film", maxSeconds: 45 },
  { script: "7", name: "07-verify-file", title: "Receipt verify from a file", devices: ["desktop"], source: "held", reason: "update 35 (verify from a file) is not on main yet", maxSeconds: 25 },
  { script: "8", name: "08-contracts", title: "Contracts page", devices: ["desktop"], source: "held", reason: "the contracts page is not on the live site (the anchor is not on 4663 yet, E4)", maxSeconds: 20 },
  { script: "9", name: "09-perk", title: "Locked and unlocked perk", devices: ["desktop"], source: "held", reason: "updates 36 and 40 are not on main or the live site yet", maxSeconds: 30 },
];

/** The clip numbers a shot list names: "## Clip N" headings plus the numbered items under "## Kit clips". */
export function scriptClips(md: string): string[] {
  const out: string[] = [];
  let inKit = false;
  for (const line of md.split("\n")) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      inKit = /^kit clips/i.test(h[1]!.trim());
      const c = /^clip\s+(\d+)\b/i.exec(h[1]!.trim());
      if (c) out.push(c[1]!);
      continue;
    }
    const item = inKit ? /^(\d+)\.\s/.exec(line) : null;
    if (item) out.push(item[1]!);
  }
  return out;
}

/** Script clips with no entry in CLIPS (empty when the recorder covers the whole script). */
export function missingClips(md: string, clips: Clip[] = CLIPS): string[] {
  const have = new Set(clips.map((c) => c.script));
  return scriptClips(md).filter((n) => !have.has(n));
}
