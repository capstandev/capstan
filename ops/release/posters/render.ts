// Render the release posters: bun ops/release/posters/render.ts --notes <dir> --out <dir> [--only 1,5,9] [--jobs 4]
//   [--chrome <path>] [--no-fit-check]
// Reads <notes>/NN.md, writes <out>/update-NN.png (wide, 1600x900, the file the runner attaches and posts) and
// <out>/update-NN-square.png (1080x1080). Each poster is the HTML template screenshotted by headless Chrome with a
// throwaway profile, so nothing touches a running browser. Every poster is also checked for text that does not fit.
// Exit 1 on any failure.

import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { KINDS, SIZES, posterHtml, posterName, readNotes, checkPosterDir, type Kind, type Note } from "./lib";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome(given?: string): string | null {
  if (given) return existsSync(given) ? given : null;
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  return CHROME_PATHS.find((p) => existsSync(p)) ?? null;
}

// Chrome helper processes can outlive the browser and hold an inherited pipe open, so output goes to a file, the
// browser gets a deadline, and any helper still carrying this call's own throwaway profile is stopped by its pid.
async function chrome(bin: string, args: string[], timeoutMs = 120000): Promise<{ code: number; out: string }> {
  const profile = mkdtempSync(join(tmpdir(), "poster-profile-"));
  const outFile = join(profile, "stdout.txt");
  try {
    const p = Bun.spawn([bin, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files",
      "--virtual-time-budget=3000", `--user-data-dir=${profile}`, ...args],
      { stdin: "ignore", stdout: Bun.file(outFile), stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const code = await p.exited;
    clearTimeout(timer);
    const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    return { code, out };
  } finally {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString();
    for (const row of ps.split("\n")) {
      if (!row.includes(`--user-data-dir=${profile}`)) continue;
      const pid = Number(row.trim().split(/\s+/)[0]);
      if (pid > 1 && pid !== process.pid) try { process.kill(pid); } catch { /* already gone */ }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

export async function renderOne(bin: string, note: Note, kind: Kind, total: number, out: string, work: string,
  fitCheck = true): Promise<string | null> {
  const here = import.meta.dir;
  const base = pathToFileURL(here + "/").href;
  const mascot = pathToFileURL(resolve(here, "../../../web/public/assets/capstan-wave.webp")).href;
  const page = join(work, `${posterName(note.n, kind)}.html`);
  writeFileSync(page, posterHtml(note, kind, total, base, mascot));
  const url = pathToFileURL(page).href;
  const { width, height } = SIZES[kind];
  const png = join(out, posterName(note.n, kind));
  const name = posterName(note.n, kind);
  // A loaded machine can make one Chrome launch fail (exit 2) or stall, so each step gets three tries; a removed old
  // file makes sure a failed screenshot is never hidden by an earlier render.
  rmSync(png, { force: true });
  let shot = { code: -1, out: "" };
  for (let i = 0; i < 3 && (shot.code !== 0 || !existsSync(png)); i++)
    shot = await chrome(bin, [`--window-size=${width},${height}`, `--screenshot=${png}`, url]);
  if (shot.code !== 0 || !existsSync(png)) return `${name}: screenshot failed (exit ${shot.code})`;
  if (fitCheck) {
    let fit = "";
    for (let i = 0; i < 3 && !fit; i++) {
      const dom = await chrome(bin, [`--window-size=${width},${height}`, "--dump-dom", url]);
      fit = /data-fit="(ok|overflow)"/.exec(dom.out)?.[1] ?? "";
    }
    if (!fit) return `${name}: fit check did not run`;
    if (fit !== "ok") return `${name}: text does not fit`;
  }
  return null;
}

async function main(argv: string[]) {
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const notesDir = arg("--notes"), outDir = arg("--out");
  if (!notesDir || !outDir) { console.error("usage: render.ts --notes <dir> --out <dir> [--only 1,2] [--jobs 4]"); return 2; }
  const bin = findChrome(arg("--chrome"));
  if (!bin) { console.error("no Chrome or Chromium found (set CHROME_BIN or pass --chrome)"); return 1; }
  const notes = readNotes(notesDir);
  const only = arg("--only")?.split(",").map(Number);
  const todo = notes.filter((n) => !only || only.includes(n.n)).flatMap((n) => KINDS.map((k) => [n, k] as const));
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "poster-pages-"));
  const jobs = Number(arg("--jobs") ?? 4);
  const errs: string[] = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < todo.length) {
      const [note, kind] = todo[next++]!;
      const e = await renderOne(bin, note, kind, notes.length, outDir, work, !argv.includes("--no-fit-check"));
      if (e) errs.push(e);
      done++;
    }
  }));
  rmSync(work, { recursive: true, force: true });
  if (!only) errs.push(...checkPosterDir(outDir, notes.length));
  for (const e of errs) console.error(`not ok - ${e}`);
  console.log(`posters: ${done} rendered, ${errs.length} problems, in ${outDir}`);
  return errs.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
