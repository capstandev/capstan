// Page decorations every page gets from src/site/main.ts: the fork banner, the risk disclaimer where the rules ask
// for it, and the CPST token box on the home page once contracts.json has an address for the build's chain.
import type { AppConfig } from "../config";
import { FORK_BANNER, TOKEN_LINE } from "../copy";
import { CONTRACTS, cpstOn, type ContractsJson } from "../lib/contracts";
import { disclaimerHtml, tokenBoxHtml } from "./render";

export const pageOf = (body: HTMLElement, pathname: string) => body.dataset.page || pathname.split("/").pop()?.replace(/\.html$/, "") || "index";

/** Pages that carry the risk disclaimer (DECISIONS #13: landing, docs, pricing, dashboard, every quote widget). */
export const DISCLAIMER_PAGES = new Set(["index", "pricing", "dashboard", "quotes", "risk", "markets"]);

export function decorate(cfg: AppConfig, page: string, doc: Document = document, contracts: ContractsJson = CONTRACTS) {
  if (cfg.profile === "fork" && !doc.querySelector("[data-fork-banner]")) {
    const b = doc.createElement("p");
    b.className = "cap-fork-banner";
    b.setAttribute("role", "note");
    b.dataset.forkBanner = "";
    b.textContent = FORK_BANNER;
    doc.body.prepend(b);
  }
  if (DISCLAIMER_PAGES.has(page) && !doc.querySelector("[data-disclaimer]")) {
    const where = page === "dashboard" ? doc.querySelector(".dash-main #dash-content") : doc.querySelector("main.bl-page");
    if (page === "dashboard") where?.insertAdjacentHTML("afterend", disclaimerHtml());
    else where?.insertAdjacentHTML("beforeend", `<section class="bl-section cap-disclaimer-section"><div class="bl-wrap">${disclaimerHtml()}</div></section>`);
  }
  if (page === "index") {
    const e = cpstOn(cfg.tokenChainId, contracts);
    const after = doc.querySelector("main.bl-page > section.bl-hero");
    if (e && after && !doc.querySelector("[data-token-box]")) {
      after.insertAdjacentHTML("afterend", tokenBoxHtml(e, cfg.explorerBase, TOKEN_LINE));
      doc.querySelector<HTMLButtonElement>("[data-token-box] [data-copy]")?.addEventListener("click", (ev) => {
        const btn = ev.currentTarget as HTMLButtonElement;
        void navigator.clipboard?.writeText(btn.dataset.copy ?? "").then(() => (btn.textContent = "Copied"));
      });
    }
  }
}

