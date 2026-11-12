import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIPS, missingClips, scriptClips } from "../clips";

// The shot list lives in the private docs folder next to the repo; CAPSTAN_VIDEO_SCRIPT points elsewhere.
const SCRIPT = process.env.CAPSTAN_VIDEO_SCRIPT ?? resolve(import.meta.dir, "../../../../docs/marketing/videos/SCRIPT.md");

const SAMPLE = `# Demo videos
## Clip 0: overview (25 to 30 s)
| s | Shot | Caption |
| 0 to 4 | Landing | x |
## Kit clips
1. Quote compare (30 s).
2. Onboarding per venue: Hyperliquid, Lighter, Aster (each 40 s), showing what is signed and that no approval can
   withdraw.
3. Risk panel (30 s).
## Honest caveats
1. Not a clip.
`;

describe("demo clip list", () => {
  test("the parser reads the overview heading and only the kit list items", () => {
    expect(scriptClips(SAMPLE)).toEqual(["0", "1", "2", "3"]);
    expect(missingClips(SAMPLE, CLIPS.filter((c) => c.script !== "3"))).toEqual(["3"]);
  });

  test("every clip in the shot list has an entry (recorded or held with a reason)", () => {
    const md = existsSync(SCRIPT) ? readFileSync(SCRIPT, "utf8") : null;
    if (md) {
      expect(scriptClips(md).length).toBeGreaterThan(0);
      expect(missingClips(md)).toEqual([]);
    }
    for (const c of CLIPS) {
      if (c.source === "held") expect(c.reason?.length ?? 0).toBeGreaterThan(10);
      expect(c.maxSeconds).toBeLessThanOrEqual(59);
    }
  });
});
