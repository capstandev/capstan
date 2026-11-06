// The ops alert glossary (ops/alerts/GLOSSARY.md) is the single list of alert causes. Code may only raise a cause
// listed there; `assertCausesKnown` runs when the ops-alerts worker starts and refuses to start otherwise (rule R9).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Severity = "info" | "act" | "critical";
export interface GlossaryEntry {
  cause: string;
  severity: Severity;
  means: string;
  todo: string;
}

export const GLOSSARY_PATH = join(import.meta.dir, "..", "..", "..", "ops", "alerts", "GLOSSARY.md");

export function parseGlossary(text: string): Map<string, GlossaryEntry> {
  const out = new Map<string, GlossaryEntry>();
  const blocks = text.split(/^## /m).slice(1);
  for (const b of blocks) {
    const lines = b.split("\n");
    const cause = lines[0]!.trim().replace(/`/g, "");
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(cause)) throw new Error(`glossary: bad cause name "${cause}"`);
    const get = (label: string) => {
      const i = lines.findIndex((l) => l.startsWith(`${label}:`));
      if (i < 0) return "";
      const parts = [lines[i]!.slice(label.length + 1).trim()];
      for (let j = i + 1; j < lines.length && lines[j]!.trim() && !/^(Severity|Means|Do):/.test(lines[j]!); j++) parts.push(lines[j]!.trim());
      return parts.join(" ");
    };
    const severity = get("Severity") as Severity;
    if (!["info", "act", "critical"].includes(severity)) throw new Error(`glossary: ${cause} has no valid Severity`);
    const means = get("Means");
    const todo = get("Do");
    if (!means || !todo) throw new Error(`glossary: ${cause} needs Means and Do lines`);
    if (out.has(cause)) throw new Error(`glossary: ${cause} listed twice`);
    out.set(cause, { cause, severity, means, todo });
  }
  return out;
}

let cached: Map<string, GlossaryEntry> | null = null;
export function loadGlossary(path = GLOSSARY_PATH): Map<string, GlossaryEntry> {
  if (path === GLOSSARY_PATH && cached) return cached;
  const g = parseGlossary(readFileSync(path, "utf8"));
  if (path === GLOSSARY_PATH) cached = g;
  return g;
}

export class UnknownCauseError extends Error {
  constructor(readonly causes: string[]) {
    super(`ops alerts: causes missing from ops/alerts/GLOSSARY.md: ${causes.join(", ")}`);
    this.name = "UnknownCauseError";
  }
}

/** Throws when any cause is not in the glossary. */
export function assertCausesKnown(causes: Iterable<string>, glossary = loadGlossary()): void {
  const missing = [...new Set(causes)].filter((c) => !glossary.has(c)).sort();
  if (missing.length) throw new UnknownCauseError(missing);
}
