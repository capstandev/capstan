// data/release-queue.md (the release queue table, copied from the release tools) -> data/roadmap.json (what
// /roadmap is built from). Run `bun scripts/sync-roadmap.ts` after the queue copy changes; test/roadmap.test.tsx
// fails when roadmap.json and the queue table differ, so the page cannot drift from the queue.
// Times are relative to launch ("Day 1, +4 h"); no calendar date is stored until the owner names the launch time.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WEB_ROOT = join(import.meta.dir, "..");
export const QUEUE_SOURCE = join(WEB_ROOT, "data/release-queue.md");
export const ROADMAP_TARGET = join(WEB_ROOT, "data/roadmap.json");

export type BonusWhen = "launch day" | "later";

export interface QueueUpdate {
  n: number;
  title: string;
  line: string;
  lane: string;
  tier: string;
  /** day after launch, 1 to 3 */
  day: number;
  /** hours into that day: "Day 1, +4 h" is day 1, hour 4 */
  hour: number;
}

export interface QueueBonus {
  n: number;
  key: string;
  when: BonusWhen;
  title: string;
  line: string;
}

export interface RoadmapExport {
  about: string;
  cadenceMinutes: number;
  updates: QueueUpdate[];
  bonuses: QueueBonus[];
}

const ABOUT =
  "Made by scripts/sync-roadmap.ts from data/release-queue.md; do not edit by hand. Times are relative to launch: day after launch and hours into that day, one update an hour.";

const cells = (l: string) => l.slice(1, -1).split(" | ").map((c) => c.trim());

/** The update rows and bonus rows of the queue table, in file order. */
export function parseQueue(md: string): { updates: QueueUpdate[]; bonuses: QueueBonus[] } {
  const updates: QueueUpdate[] = [];
  const bonuses: QueueBonus[] = [];
  let inBonus = false;
  for (const raw of md.split("\n")) {
    const l = raw.trim();
    if (/^##\s+Bonus/i.test(l)) inBonus = true;
    if (!/^\|\s*\d+\s*\|/.test(l)) continue;
    const c = cells(l);
    if (!inBonus) {
      const at = /^Day (\d+), \+(\d+) h$/.exec(c[1] ?? "");
      if (c.length !== 6 || !at) throw new Error(`release-queue.md: bad update row: ${l}`);
      updates.push({ n: Number(c[0]), day: Number(at[1]), hour: Number(at[2]), lane: c[2]!, tier: c[3]!, title: c[4]!, line: c[5]! });
    } else {
      if (c.length !== 5 || (c[2] !== "launch day" && c[2] !== "later")) throw new Error(`release-queue.md: bad bonus row: ${l}`);
      bonuses.push({ n: Number(c[0]), key: c[1]!, when: c[2] as BonusWhen, title: c[3]!, line: c[4]! });
    }
  }
  return { updates, bonuses };
}

export function roadmapFromQueue(md: string): RoadmapExport {
  const { updates, bonuses } = parseQueue(md);
  return { about: ABOUT, cadenceMinutes: 60, updates, bonuses };
}

if (import.meta.main) {
  const r = roadmapFromQueue(readFileSync(QUEUE_SOURCE, "utf8"));
  writeFileSync(ROADMAP_TARGET, `${JSON.stringify(r, null, 1)}\n`);
  console.log(`roadmap: wrote data/roadmap.json (${r.updates.length} updates, ${r.bonuses.length} bonuses)`);
}
