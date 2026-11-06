// R4: the quote table keeps fee, builder fee, slippage, funding and liquidation price in separate columns, greys
// data-only rows with "data only", and never marks a data-only row best (even when the server says so).
import { describe, expect, test } from "bun:test";
import { QUOTE_COLUMNS } from "../../src/app/screens/QuoteTable";
import { DISCLAIMER } from "../../src/copy";
import { byText, click, typeInto, waitFor } from "../helpers";
import { quote } from "./fixtures";
import { connect, go, startDash } from "./harness";

async function table(best: string) {
  const d = await startDash({ intercept: (url) => (url.pathname.endsWith("/quote") ? Response.json(quote(best)) : undefined) });
  await connect(d);
  await go(d, "Quote");
  const form = await waitFor(() => d.m.host.querySelector("[data-screen=quote] form"), "the quote form");
  await typeInto(form.querySelector("input")!, "EQ:TSLA");
  await click(byText(d.m.host, "button", "Get quote"));
  const t = await waitFor(() => d.m.host.querySelector("[data-quote-table]"), "the quote table");
  return { d, t };
}

describe("quote", () => {
  test("columns-and-data-only", async () => {
    // the server names the data-only row best: the table marks nothing best
    const a = await table("variational:-:TSLA");
    try {
      const head = Array.from(a.t.querySelectorAll("thead th")).map((h) => h.textContent);
      expect(head).toEqual([...QUOTE_COLUMNS]);
      for (const c of ["Venue fee", "Builder fee", "Slippage", "Funding per hour", "Est. liquidation price"]) expect(head.filter((h) => h === c).length).toBe(1);
      const rows = Array.from(a.t.querySelectorAll("tbody tr"));
      expect(rows.length).toBe(3);
      for (const r of rows) expect(r.querySelectorAll("td").length).toBe(QUOTE_COLUMNS.length);
      const hl = a.t.querySelector('[data-market="hyperliquid:xyz:TSLA"]')!;
      expect(hl.querySelector("[data-col=venue-fee]")!.textContent).toBe("4.50 bps");
      expect(hl.querySelector("[data-col=builder-fee]")!.textContent).toBe("2 bps");
      expect(hl.querySelector("[data-col=slippage]")!.textContent).toBe("1.50 bps");
      expect(hl.querySelector("[data-col=funding]")!.textContent).toBe("1 bps"); // 24 bps over 24 hours
      expect(hl.querySelector("[data-col=liq]")!.textContent).toBe("452.10");
      const v = a.t.querySelector('[data-market="variational:-:TSLA"]')!;
      expect(v.className).toBe("data-only");
      expect(v.querySelector("[data-col=status]")!.textContent).toBe("data only");
      expect(a.t.querySelectorAll("[data-best]").length).toBe(0);
      expect(a.t.textContent).not.toContain("(best)");
      // the widget carries the disclaimer
      const widget = a.d.m.host.querySelector("[data-screen=quote]")!;
      for (const l of DISCLAIMER.lines) expect(widget.textContent).toContain(l);
    } finally {
      await a.d.stop();
    }
    // an executable best is marked, once
    const b = await table("hyperliquid:xyz:TSLA");
    try {
      const marked = Array.from(b.t.querySelectorAll("[data-best]")).map((r) => r.getAttribute("data-market"));
      expect(marked).toEqual(["hyperliquid:xyz:TSLA"]);
    } finally {
      await b.d.stop();
    }
  }, 30_000);
});
