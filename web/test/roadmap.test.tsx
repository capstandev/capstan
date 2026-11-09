// Tracker 86: /roadmap and /changelog. The data is made at build time (scripts/sync-releases.ts) from the release
// queue export (data/roadmap.json) and the public CHANGELOG.md; an update reads LIVE only when its "Update N:" entry
// is in CHANGELOG.md, every other one reads "planned"; /changelog lists released entries newest first.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { CHANGELOG_SOURCE, parseChangelog, readRoadmap, releasePages, ROADMAP_SOURCE, type ReleasePages } from "../scripts/sync-releases";
import { READ_BY_PATH } from "../scripts/build-inputs";
import { Changelog } from "../src/pages/Changelog";
import { Roadmap } from "../src/pages/Roadmap";
import releasesJson from "../src/generated/releases.json";

const WEB = join(import.meta.dir, "..");
const releases = releasesJson as unknown as ReleasePages;
const dom = (el: ReactElement) => {
  const d = document.createElement("div");
  d.innerHTML = renderToStaticMarkup(el);
  return d;
};

/** The shape the release runner writes: an Unreleased dev section, then dated public entries. */
const SAMPLE = `# Changelog

## Unreleased

- Update 9: not released yet, so never live.
- Foundation: the shared schema package.

## 2026-11-21

- Update 1: The MCP endpoint now explains itself.
- Fix: Roadmap page
- Update 2: Health shows the running commit.

## 2026-11-22 (Day 2)

- **Bonus update 1:** A bonus line.
- Update 25: Later line (2026-11-23)
`;

describe("CHANGELOG.md parsing", () => {
  test("only released entries, newest first; Unreleased never counts", () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      { kind: "update", n: 25, line: "Later line", date: "2026-11-23" },
      { kind: "bonus", n: 1, line: "A bonus line.", date: "2026-11-22" },
      { kind: "update", n: 2, line: "Health shows the running commit.", date: "2026-11-21" },
      { kind: "fix", n: null, line: "Roadmap page", date: "2026-11-21" },
      { kind: "update", n: 1, line: "The MCP endpoint now explains itself.", date: "2026-11-21" },
    ]);
  });

  test("the repo's CHANGELOG.md has no released entry before launch (its notes sit under Unreleased)", () => {
    expect(parseChangelog(readFileSync(CHANGELOG_SOURCE, "utf8"))).toEqual([]);
  });
});

describe("/roadmap", () => {
  test("all-72-present: the export holds updates 1 to 72 with title, plain line, day and slot", () => {
    const r = readRoadmap();
    expect(r.updates.map((u) => u.n)).toEqual(Array.from({ length: 72 }, (_, i) => i + 1));
    for (const u of r.updates) expect({ n: u.n, day: u.day, slot: u.slot }).toEqual({ n: u.n, day: Math.floor((u.n - 1) / 24) + 1, slot: ((u.n - 1) % 24) + 1 });
    const v = dom(<Roadmap />);
    expect(v.querySelector("h1")!.textContent).toBe("Roadmap");
    expect([...v.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Day 1", "Day 2", "Day 3"]);
    expect(v.querySelectorAll("[data-update]").length).toBe(72);
    const first = v.querySelector('[data-update="1"]')!;
    expect(first.querySelector("h3")!.textContent).toBe(`Update 1: ${r.updates[0]!.title}`);
    expect(first.textContent).toContain(r.updates[0]!.line);
    expect(first.textContent).toContain("Planned slot: Day 1, slot 1");
  });

  test("before launch every badge reads planned (the build data matches the repo's own files)", () => {
    expect(releases).toEqual(releasePages(readRoadmap(), readFileSync(CHANGELOG_SOURCE, "utf8")));
    const v = dom(<Roadmap />);
    expect(v.querySelectorAll('[data-badge="planned"]').length).toBe(72);
    expect(v.querySelectorAll('[data-badge="live"]').length).toBe(0);
    expect([...v.querySelectorAll("[data-badge]")].every((b) => b.textContent === "planned")).toBe(true);
  });

  test("live-only-from-changelog: a released Update N entry flips that badge and no other", () => {
    const data = releasePages(readRoadmap(), SAMPLE);
    expect(data.updates.filter((u) => u.live).map((u) => u.n)).toEqual([1, 2, 25]);
    const v = dom(<Roadmap updates={data.updates} />);
    expect([...v.querySelectorAll('[data-badge="live"]')].map((b) => [b.closest("[data-update]")!.getAttribute("data-update"), b.textContent])).toEqual([["1", "LIVE"], ["2", "LIVE"], ["25", "LIVE"]]);
    // update 9 is only under Unreleased; the bonus and the fix never mark a queued update
    expect(v.querySelector('[data-update="9"] [data-badge]')!.textContent).toBe("planned");
    expect(v.querySelectorAll('[data-badge="planned"]').length).toBe(69);
  });
});

describe("/changelog", () => {
  test("says there are no releases until CHANGELOG.md has an entry", () => {
    const v = dom(<Changelog entries={[]} />);
    expect(v.querySelector("h1")!.textContent).toBe("Changelog");
    expect(v.querySelector("[data-changelog-empty]")!.textContent).toBe("No releases yet. The first update ships at launch.");
    expect(dom(<Changelog />).querySelector("[data-changelog-empty]")).not.toBeNull();
  });

  test("renders released entries newest first with their dates", () => {
    const v = dom(<Changelog entries={parseChangelog(SAMPLE)} />);
    expect(v.querySelector("[data-changelog-empty]")).toBeNull();
    expect([...v.querySelectorAll("li h2")].map((h) => h.textContent)).toEqual([
      "Update 25: Later line",
      "Bonus update 1: A bonus line.",
      "Update 2: Health shows the running commit.",
      "Fix: Roadmap page",
      "Update 1: The MCP endpoint now explains itself.",
    ]);
    expect(v.querySelector("li time")!.getAttribute("datetime")).toBe("2026-11-23");
  });
});

describe("site wiring", () => {
  test("both pages exist in the owner's page shell, mount through main.ts and are linked from the footer", () => {
    const status = readFileSync(join(WEB, "status.html"), "utf8");
    for (const p of ["roadmap", "changelog"]) {
      expect(readFileSync(join(WEB, `${p}.html`), "utf8")).toBe(status.replace('data-page="status"', `data-page="${p}"`));
    }
    const views = readFileSync(join(WEB, "public/bloop-views.js"), "utf8");
    expect(views).toContain("['docs','verify','status','legal','roadmap','changelog','404'].includes(page)");
    expect(views).toContain('<a href="roadmap.html">Roadmap</a><a href="changelog.html">Changelog</a>');
    const main = readFileSync(join(WEB, "src/site/main.ts"), "utf8");
    expect(main).toContain('case "roadmap":');
    expect(main).toContain('case "changelog":');
  });

  test("the build reads CHANGELOG.md and the export, and vercel.json serves clean URLs", () => {
    expect(READ_BY_PATH).toContain("CHANGELOG.md");
    expect(ROADMAP_SOURCE.startsWith(WEB)).toBe(true);
    const cfg = JSON.parse(readFileSync(join(WEB, "vercel.json"), "utf8")) as { cleanUrls: boolean; trailingSlash: boolean };
    expect({ cleanUrls: cfg.cleanUrls, trailingSlash: cfg.trailingSlash }).toEqual({ cleanUrls: true, trailingSlash: false });
  });
});
