// After `vite build` and hash-public.ts: writes each main page's text into its static HTML, so a crawler that runs no
// JavaScript reads the page. The owner's app.js draws every page into an empty <div id="app"> at load; this script runs
// the built bloop-views.js and app.js once per page in happy-dom, takes the exact markup app.js puts into #app, and
// writes it inside #app in dist/<page>.html. /docs also gets the API docs (the React page, rendered to static markup
// from the same generated OpenAPI file and MCP tool table). In the browser nothing changes: app.js still sets #app
// and React still mounts into the (again empty) #cap-live, so the page runs exactly as before. The copy is the
// owner's, byte for byte: nothing here writes text of its own. Title and meta description stay as each page has them.
// /roadmap and /changelog are React pages too (the release queue and the released entries): same treatment as /docs.
// Usage: bun scripts/prerender.ts [distDir]
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const WEB = resolve(import.meta.dir, "..");

/** The pages crawlers must read (the launch check's list): file stem and the URL path it is served at. */
export const PRERENDER: { page: string; path: string }[] = [
  { page: "index", path: "/" },
  { page: "how-it-works", path: "/how-it-works" },
  { page: "pricing", path: "/pricing" },
  { page: "developers", path: "/developers" },
  { page: "markets", path: "/markets" },
  { page: "docs", path: "/docs" },
  { page: "roadmap", path: "/roadmap" },
  { page: "changelog", path: "/changelog" },
];

/** Pages whose body is a React page mounted into #cap-live (app.js draws only the frame around it). */
export const LIVE_PAGES = ["docs", "roadmap", "changelog"] as const;

const EMPTY_APP = '<div id="app"></div>';

/** The built src of a classic script whose public name was `stem.js` (hash-public renames it assets/stem-<hash>.js). */
function scriptSrc(html: string, stem: string): string {
  const re = new RegExp(`<script[^>]*\\ssrc="([^"]*\\b${stem}(?:-[A-Za-z0-9]+)?\\.js)(?:\\?[^"]*)?"`);
  const m = re.exec(html);
  if (!m?.[1]) throw new Error(`prerender: no ${stem}.js script in the page`);
  return m[1].replace(/^\.?\//, "");
}

/** The markup app.js writes into #app for one page, as the exact string it assigns (before any script changes it). */
export function appMarkup(dist: string, html: string, path: string): string {
  const code = ["bloop-views", "app"].map((s) => readFileSync(join(dist, scriptSrc(html, s)), "utf8")).join("\n;\n");
  const body = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  if (!body) throw new Error("prerender: no <body>");
  const page = /data-page="([^"]+)"/.exec(body[1] ?? "")?.[1];
  GlobalRegistrator.register({ url: `https://get-capstan.com${path}`, width: 1280, height: 900 });
  let captured: string | null = null;
  try {
    if (page) document.body.dataset.page = page;
    document.body.innerHTML = (body[2] ?? "").replace(/<script[\s\S]*?<\/script>/g, "");
    const app = document.getElementById("app");
    if (!app) throw new Error("prerender: no #app");
    const proto = Object.getPrototypeOf(app) as object;
    let d: PropertyDescriptor | undefined;
    for (let o: object | null = proto; o && !d; o = Object.getPrototypeOf(o)) d = Object.getOwnPropertyDescriptor(o, "innerHTML");
    const set = d?.set;
    if (!set) throw new Error("prerender: no innerHTML setter");
    Object.defineProperty(app, "innerHTML", {
      configurable: true,
      get: () => captured ?? "",
      set(v: string) {
        if (captured === null) captured = String(v);
        set.call(app, v);
      },
    });
    try {
      (0, eval)(code);
    } catch (e) {
      // the page's later setup (motion, menus) may need a real browser; only the first #app write matters here
      if (captured === null) throw e;
    }
  } finally {
    void GlobalRegistrator.unregister();
  }
  if (!captured) throw new Error(`prerender: app.js wrote nothing into #app for ${path}`);
  return captured;
}

/** The /docs page body: the React page with its two generated files given up front (the browser loads them lazily). */
async function docsMarkup(): Promise<string> {
  const [{ ApiDocs }, openapi, tools] = await Promise.all([import("../src/pages/ApiDocs"), import("../src/generated/openapi.json"), import("../src/generated/mcp-tools.json")]);
  return renderToStaticMarkup(createElement(ApiDocs, { doc: openapi.default as never, tools: tools.default as never }));
}

/** The static markup of a React page, from the same build-time data the browser bundle carries. */
async function liveMarkup(page: (typeof LIVE_PAGES)[number]): Promise<string> {
  if (page === "docs") return docsMarkup();
  if (page === "roadmap") return renderToStaticMarkup(createElement((await import("../src/pages/Roadmap")).Roadmap));
  return renderToStaticMarkup(createElement((await import("../src/pages/Changelog")).Changelog));
}

export async function prerender(dist: string): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const { page, path } of PRERENDER) {
    const file = join(dist, `${page}.html`);
    const html = readFileSync(file, "utf8");
    if (html.split(EMPTY_APP).length !== 2) throw new Error(`prerender: ${page}.html must hold exactly one empty #app`);
    let inner = appMarkup(dist, html, path);
    const livePage = LIVE_PAGES.find((p) => p === page);
    if (livePage) {
      const live = `<div id="cap-live" class="cap-live" data-live-page="${livePage}"></div>`;
      if (inner.split(live).length !== 2) throw new Error(`prerender: ${livePage} has no empty #cap-live`);
      const body = await liveMarkup(livePage);
      inner = inner.replace(live, () => live.replace("></div>", `>${body}</div>`));
    }
    writeFileSync(file, html.replace(EMPTY_APP, () => `<div id="app">${inner}</div>`));
    sizes[page] = inner.length;
  }
  return sizes;
}

if (import.meta.main) {
  const dist = resolve(process.argv[2] ?? join(WEB, "dist"));
  const sizes = await prerender(dist);
  console.log(`prerender: ${Object.entries(sizes).map(([p, n]) => `${p} ${n}B`).join(", ")}`);
}
