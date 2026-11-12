import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPosterDir, KINDS, parseNote, posterHtml, posterName, pngSize, SIZES, tagOf, type Kind } from "./lib";
import { findChrome, renderOne } from "./render";

const RELEASE = join(import.meta.dir, "..");
const COUNT = 72;

function fakePng(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

function fillDir(dir: string) {
  for (let n = 1; n <= COUNT; n++)
    for (const k of KINDS) writeFileSync(join(dir, posterName(n, k)), fakePng(SIZES[k].width, SIZES[k].height));
}

const NOTE = `# Update 7: Security headers on the API host

## Public note

On by default.

## CHANGELOG entry

Update 7: The API host now sends <strict> security headers & a CSP.

## Telegram post
`;

describe("names the runner expects", () => {
  test("tagOf matches rr_tag_of in lib/common.sh", () => {
    const fn = readFileSync(join(RELEASE, "lib/common.sh"), "utf8").match(/^rr_tag_of\(\) .*$/m)?.[0];
    expect(fn).toBeDefined();
    for (const n of [1, 9, 10, 72]) {
      const r = Bun.spawnSync(["/bin/bash", "-c", `${fn}\nrr_tag_of ${n}`]);
      expect(r.stdout.toString()).toBe(tagOf(n));
    }
  });

  test("ghrelease.sh and announce-telegram.sh read posters/<tag>.png, the wide poster", () => {
    for (const f of ["bin/ghrelease.sh", "bin/announce-telegram.sh"])
      expect(readFileSync(join(RELEASE, f), "utf8")).toContain('"$RR_HOME/posters/$tag.png"');
    expect(posterName(5, "wide")).toBe("update-05.png");
    expect(posterName(5, "square")).toBe("update-05-square.png");
    expect(SIZES.wide).toEqual({ width: 1600, height: 900 });
    expect(SIZES.square).toEqual({ width: 1080, height: 1080 });
  });
});

describe("notes", () => {
  test("parseNote reads number, title and the plain CHANGELOG line", () => {
    expect(parseNote(NOTE)).toEqual({
      n: 7, title: "Security headers on the API host", line: "The API host now sends <strict> security headers & a CSP.",
    });
  });

  test("a CHANGELOG line that only repeats the title gives way to the Stated plainly line", () => {
    const note = "# Update 6: MCP tool capstan_venues\n\n## CHANGELOG entry\n\nUpdate 6: New MCP tool capstan_venues.\n\n" +
      "Stated plainly: Venue status is as fresh as our last read.\n";
    expect(parseNote(note).line).toBe("Venue status is as fresh as our last read.");
    expect(parseNote(NOTE).line).toContain("security headers");
  });

  test("parseNote refuses a note with no CHANGELOG entry or with an em dash", () => {
    expect(() => parseNote("# Update 3: x\n\nbody\n")).toThrow("no CHANGELOG entry");
    expect(() => parseNote(NOTE.replace("a CSP", "a CSP — now"))).toThrow("em dash");
  });

  test("posterHtml fills every field and escapes the text", () => {
    const html = posterHtml(parseNote(NOTE), "square", COUNT, "file:///x/", "file:///m.webp");
    expect(html).not.toContain("{{");
    expect(html).toContain("&lt;strict&gt; security headers &amp; a CSP");
    expect(html).toContain("Tech update 7 of 72");
    expect(html).toContain('<body class="square">');
  });
});

describe("poster folder check", () => {
  test("pngSize reads IHDR and refuses other bytes", () => {
    expect(pngSize(fakePng(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(pngSize(new TextEncoder().encode("not a png at all, really not"))).toBeNull();
  });

  test("72 x 2 files with the right names and sizes pass; a missing or wrong-size file fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "posters-test-"));
    try {
      fillDir(dir);
      expect(checkPosterDir(dir, COUNT)).toEqual([]);
      unlinkSync(join(dir, "update-72-square.png"));
      writeFileSync(join(dir, "update-09.png"), fakePng(1080, 1080));
      writeFileSync(join(dir, "update-10.png"), "text");
      expect(checkPosterDir(dir, COUNT)).toEqual([
        "update-09.png: 1080x1080, want 1600x900",
        "update-10.png: not a PNG",
        "update-72-square.png: missing",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Set POSTERS_DIR to the rendered folder to check the real 144 files.
  test.skipIf(!process.env.POSTERS_DIR)("POSTERS_DIR holds all 72 x 2 posters at the right sizes", () => {
    expect(checkPosterDir(process.env.POSTERS_DIR as string, COUNT)).toEqual([]);
  });
});

describe("render", () => {
  test.skipIf(!findChrome())("one poster of each kind renders at its size with the text fitting", async () => {
    const out = mkdtempSync(join(tmpdir(), "posters-render-"));
    const work = join(out, "pages");
    mkdirSync(work);
    try {
      const note = parseNote(NOTE);
      for (const kind of KINDS as Kind[]) {
        expect(await renderOne(findChrome() as string, note, kind, COUNT, out, work)).toBeNull();
        expect(pngSize(readFileSync(join(out, posterName(7, kind))))).toEqual(SIZES[kind]);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60000);
});
