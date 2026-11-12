// Release posters: one wide and one square PNG per tech update, rendered from one HTML template.
// The runner stages posters by exact tag: ghrelease.sh attaches $RR_HOME/posters/<tag>.png to the GitHub Release and
// announce-telegram.sh posts the same file to the team group. So <tag>.png is the wide poster; the square one sits
// next to it as <tag>-square.png for reposts. Tags come from rr_tag_of in ops/release/lib/common.sh: update-NN.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const SIZES = {
  wide: { width: 1600, height: 900 },
  square: { width: 1080, height: 1080 },
} as const;
export type Kind = keyof typeof SIZES;
export const KINDS: Kind[] = ["wide", "square"];

export interface Note {
  n: number;
  title: string;
  line: string;
}

/** Same as rr_tag_of in ops/release/lib/common.sh. */
export function tagOf(n: number): string {
  return `update-${String(n).padStart(2, "0")}`;
}

export function posterName(n: number, kind: Kind): string {
  return kind === "wide" ? `${tagOf(n)}.png` : `${tagOf(n)}-square.png`;
}

/**
 * Read one notes file (docs/tech-updates/notes/NN.md): "# Update N: title", then a "## CHANGELOG entry" section whose
 * first paragraph is "Update N: one plain line". The poster shows the number, the title and that line.
 */
export function parseNote(text: string): Note {
  const head = /^# Update (\d+): (.+)$/m.exec(text);
  if (!head) throw new Error("notes file has no '# Update N: title' heading");
  const n = Number(head[1] ?? "");
  const sec = /^## CHANGELOG entry\s*\n+([^\n]+)/m.exec(text);
  if (!sec) throw new Error(`update ${n}: no CHANGELOG entry`);
  const title = (head[2] ?? "").trim();
  let line = (sec[1] ?? "").trim().replace(/^Update \d+:\s*/, "");
  // When the CHANGELOG line only repeats the title ("New MCP tool capstan_venues."), the Telegram post's
  // "Stated plainly" line says more, so the poster uses that instead.
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9_$]+/g) ?? [];
  const inTitle = new Set(words(title));
  const plain = /^Stated plainly: (.+)$/m.exec(text)?.[1]?.trim();
  if (plain && words(line).filter((w) => !inTitle.has(w) && w.length > 3).length === 0) line = plain;
  for (const [what, s] of [["title", title], ["line", line]] as const) {
    if (!s) throw new Error(`update ${n}: empty ${what}`);
    if (s.includes("—")) throw new Error(`update ${n}: em dash in ${what}`);
    if (/0x[0-9a-fA-F]{40}/.test(s)) throw new Error(`update ${n}: wallet address in ${what}`);
  }
  return { n, title, line };
}

export function readNotes(dir: string): Note[] {
  const files = readdirSync(dir).filter((f) => /^\d+\.md$/.test(f)).sort();
  const notes = files.map((f) => parseNote(readFileSync(join(dir, f), "utf8")));
  notes.forEach((note, i) => {
    if (note.n !== i + 1) throw new Error(`notes are not numbered 1..N: found update ${note.n} at place ${i + 1}`);
  });
  return notes;
}

/** Width and height from a PNG's IHDR chunk; null when the bytes are not a PNG. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  if (String.fromCharCode(...buf.slice(12, 16)) !== "IHDR") return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Every problem with a poster folder for updates 1..count; an empty list means the runner has every file it needs. */
export function checkPosterDir(dir: string, count: number): string[] {
  const errs: string[] = [];
  if (!existsSync(dir)) return [`${dir} does not exist`];
  for (let n = 1; n <= count; n++) {
    for (const kind of KINDS) {
      const name = posterName(n, kind);
      const p = join(dir, name);
      if (!existsSync(p)) { errs.push(`${name}: missing`); continue; }
      const buf = readFileSync(p);
      const size = pngSize(buf);
      const want = SIZES[kind];
      if (!size) errs.push(`${name}: not a PNG`);
      else if (size.width !== want.width || size.height !== want.height)
        errs.push(`${name}: ${size.width}x${size.height}, want ${want.width}x${want.height}`);
      // Telegram sendPhoto takes at most 10 MB; GitHub assets are fine far past that.
      else if (buf.length > 10 * 1024 * 1024) errs.push(`${name}: ${buf.length} bytes, over the 10 MB photo limit`);
    }
  }
  return errs;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The poster page for one update. `base` is a file:// URL of this folder; `mascot` a file:// URL of the image. */
export function posterHtml(note: Note, kind: Kind, total: number, base: string, mascot: string): string {
  const tpl = readFileSync(join(import.meta.dir, "template.html"), "utf8");
  const { width, height } = SIZES[kind];
  const vals: Record<string, string> = {
    BASE: base, MASCOT: mascot, KIND: kind, WIDTH: String(width), HEIGHT: String(height),
    N: String(note.n), TOTAL: String(total), TITLE: escapeHtml(note.title), LINE: escapeHtml(note.line),
  };
  return tpl.replace(/\{\{([A-Z]+)\}\}/g, (_, k: string) => {
    if (!(k in vals)) throw new Error(`template field ${k} has no value`);
    return vals[k] as string;
  });
}
