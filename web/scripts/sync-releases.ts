// Build-time data for /roadmap and /changelog (src/generated/releases.json), from two files:
//   - web/data/roadmap.json: the release queue export (number, title, one plain line, lane, day and hour after launch,
//     and the bonus updates), made by scripts/sync-roadmap.ts from data/release-queue.md; regenerate after any queue change.
//   - CHANGELOG.md at the repo root: the public changelog. Only released entries count:
//       "Update N: <line>", "Bonus update N: <line>" or "Fix: <line>", as a bullet or a heading, dated by the nearest
//       "## YYYY-MM-DD ..." heading above it (or a "(YYYY-MM-DD)" at the end of the line).
//     Anything under an "Unreleased" heading is not released and never counts.
// An update shows LIVE on /roadmap only when its "Update N:" entry is in CHANGELOG.md; every other one reads
// "planned". Never derived from the clock: a held update would look live.
// Runs inside syncGenerated() (scripts/sync-openapi.ts): before every dev server, build and test run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BonusWhen, RoadmapExport } from "./sync-roadmap";

const WEB_ROOT = join(import.meta.dir, "..");
export const ROADMAP_SOURCE = join(WEB_ROOT, "data/roadmap.json");
export const CHANGELOG_SOURCE = join(WEB_ROOT, "../CHANGELOG.md");
const GENERATED = join(WEB_ROOT, "src/generated");

export type EntryKind = "update" | "bonus" | "fix";

export interface ChangelogEntry {
  kind: EntryKind;
  /** the update or bonus number; null for a fix */
  n: number | null;
  line: string;
  /** YYYY-MM-DD, or null when the entry carries no date */
  date: string | null;
}

export interface RoadmapItem {
  n: number;
  title: string;
  line: string;
  lane: string;
  tier: string;
  day: number;
  /** hours into that day after launch: "Day 1, +4 h" */
  hour: number;
  live: boolean;
}

export interface RoadmapBonus {
  n: number;
  key: string;
  when: BonusWhen;
  title: string;
  line: string;
  live: boolean;
}

export interface ReleasePages {
  updates: RoadmapItem[];
  bonuses: RoadmapBonus[];
  /** newest first */
  changelog: ChangelogEntry[];
}


const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const ENTRY = /^(?:[-*]\s+|#{2,6}\s+)?(?:\*\*)?(Update|Bonus update|Fix)(?:\s+(\d+))?:(?:\*\*)?\s+(.+?)\s*$/i;

/** Released entries of a CHANGELOG.md, newest first: by date (newest day first), then the later line first. */
export function parseChangelog(md: string): ChangelogEntry[] {
  const found: (ChangelogEntry & { at: number })[] = [];
  let sectionDate: string | null = null;
  let unreleased = false;
  md.split("\n").forEach((raw, at) => {
    const l = raw.trim();
    const m = ENTRY.exec(l);
    if (!m && /^#{2,6}\s/.test(l)) {
      unreleased = /unreleased/i.test(l);
      sectionDate = DATE.exec(l)?.[1] ?? null;
      return;
    }
    if (!m || unreleased) return;
    const word = m[1]!.toLowerCase();
    const kind: EntryKind = word === "fix" ? "fix" : word === "update" ? "update" : "bonus";
    const n = m[2] ? Number(m[2]) : null;
    if (kind !== "fix" && n === null) return;
    if (kind === "fix" && n !== null) return;
    let line = m[3]!;
    const tail = /\s*\((\d{4}-\d{2}-\d{2})\)$/.exec(line);
    if (tail) line = line.slice(0, tail.index);
    found.push({ kind, n, line, date: tail?.[1] ?? sectionDate, at });
  });
  found.sort((a, b) => (a.date === b.date ? b.at - a.at : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? 1 : -1));
  return found.map(({ at: _at, ...e }) => e);
}

/** The /roadmap and /changelog data: every queued update, LIVE only when CHANGELOG.md has its "Update N:" entry. */
export function releasePages(roadmap: RoadmapExport, changelogMd: string): ReleasePages {
  const changelog = parseChangelog(changelogMd);
  const released = new Set(changelog.filter((e) => e.kind === "update").map((e) => e.n));
  const bonusReleased = new Set(changelog.filter((e) => e.kind === "bonus").map((e) => e.n));
  const updates = [...roadmap.updates]
    .sort((a, b) => a.n - b.n)
    .map((u) => ({ n: u.n, title: u.title, line: u.line, lane: u.lane, tier: u.tier, day: u.day, hour: u.hour, live: released.has(u.n) }));
  const bonuses = [...roadmap.bonuses]
    .sort((a, b) => a.n - b.n)
    .map((b) => ({ n: b.n, key: b.key, when: b.when, title: b.title, line: b.line, live: bonusReleased.has(b.n) }));
  return { updates, bonuses, changelog };
}

export function readRoadmap(path = ROADMAP_SOURCE): RoadmapExport {
  const r = JSON.parse(readFileSync(path, "utf8")) as RoadmapExport;
  if (!Array.isArray(r.updates) || r.updates.length === 0) throw new Error(`${path}: no updates`);
  for (const u of r.updates) {
    if (!Number.isInteger(u.n) || !u.title || !u.line || !u.lane || !Number.isInteger(u.day) || !Number.isInteger(u.hour)) throw new Error(`${path}: bad entry ${JSON.stringify(u)}`);
  }
  if (!Array.isArray(r.bonuses)) throw new Error(`${path}: no bonuses list`);
  for (const b of r.bonuses) {
    if (!Number.isInteger(b.n) || !b.title || !b.line || (b.when !== "launch day" && b.when !== "later")) throw new Error(`${path}: bad bonus ${JSON.stringify(b)}`);
  }
  return r;
}

export function syncReleases(): { updates: number; live: number; entries: number } {
  const data = releasePages(readRoadmap(), readFileSync(CHANGELOG_SOURCE, "utf8"));
  mkdirSync(GENERATED, { recursive: true });
  writeFileSync(join(GENERATED, "releases.json"), `${JSON.stringify(data, null, 1)}\n`);
  return { updates: data.updates.length, live: data.updates.filter((u) => u.live).length, entries: data.changelog.length };
}
