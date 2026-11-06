// WCAG contrast for the colour pairs styles.css uses. Every text pair must reach 4.5:1 (AA); the focus ring 3:1.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CSS_FILE = join(import.meta.dir, "../src/styles.css");

export function cssVars(css = readFileSync(CSS_FILE, "utf8")): Record<string, string> {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

export function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** [foreground, background, minimum] for every pair the stylesheet draws. */
export const PAIRS: [string, string, number][] = [
  ["ink", "paper", 4.5],
  ["muted", "paper", 4.5],
  ["link", "paper", 4.5],
  ["ink", "soft", 4.5],
  ["muted", "soft", 4.5],
  ["link", "soft", 4.5],
  ["on-navy", "navy", 4.5],
  ["navy", "paper", 4.5],
  ["warn-ink", "warn-bg", 4.5],
  ["bad-ink", "bad-bg", 4.5],
  ["good-ink", "good-bg", 4.5],
  ["on-navy", "bad-ink", 4.5],
  ["link", "warn-bg", 4.5],
  ["focus", "paper", 3],
  ["focus", "navy", 3],
];
