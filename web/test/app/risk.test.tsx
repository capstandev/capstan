// R3: one card per venue, each with its own liquidation price, under the exact banner; no total margin or total
// collateral figure anywhere on the page (DOM scan). The read is signed with purpose read over the exact path.
import { describe, expect, test } from "bun:test";
import { byText, click, waitFor } from "../helpers";
import { TOTALS, VIEW } from "./fixtures";
import { connect, go, startDash } from "./harness";

describe("risk", () => {
  test("cards-and-no-totals", async () => {
    let readHeaders: Headers | null = null;
    const d = await startDash({
      intercept: (url, init) => {
        if (url.pathname.endsWith("/risk")) {
          readHeaders = new Headers(init?.headers);
          return Response.json(VIEW);
        }
        return undefined;
      },
    });
    try {
      await connect(d);
      await go(d, "Risk");
      await click(await waitFor(() => byText(d.m.host, "button", "Read my venue accounts"), "the read button"));
      const view = await waitFor(() => d.m.host.querySelector("[data-risk-view]"), "the risk view");

      // the banner, exactly, above every card
      const banner = view.querySelector("[data-risk-banner]")!;
      expect(banner.textContent).toBe("Each venue liquidates independently. Nothing here is shared margin.");
      const cards = Array.from(view.querySelectorAll("[data-venue-card]"));
      expect(cards.map((c) => c.getAttribute("data-venue-card"))).toEqual(["hyperliquid", "lighter-rh"]);
      for (const c of cards) expect(banner.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // each card has its own liquidation price
      expect(cards[0]!.querySelector("[data-liq]")!.textContent).toBe("452.10");
      expect(cards[1]!.querySelector("[data-liq]")!.textContent).toBe("251.30");
      expect(cards[0]!.textContent).not.toContain("251.30");
      expect(cards[1]!.textContent).not.toContain("452.10");

      // DOM scan: no total margin or collateral wording, and no number that adds up venues
      const page = d.m.host.textContent!;
      expect(page).not.toMatch(TOTALS);
      for (const sum of ["2400", "2,400", "1100", "1,100"]) expect(page).not.toContain(sum);
      expect(view.querySelectorAll("[data-total], [data-sum]").length).toBe(0);

      // the read was signed by the owner with purpose read, over GET /v1/risk?owner=
      const msg = atob(readHeaders!.get("x-capstan-message")!);
      expect(msg.split("\n")[0]).toBe("Capstan read");
      expect(msg).toContain(`owner: ${d.wallet.owner}`);
      expect(readHeaders!.get("x-capstan-signature")).toMatch(/^0x[0-9a-f]{130}$/);
      const { bodyHash } = await import("../../../packages/sdk/src/signed-message");
      expect(msg).toContain(`body: ${bodyHash(`GET /v1/risk?owner=${d.wallet.owner}`)}`);
    } finally {
      await d.stop();
    }
    // the scan catches a total
    expect("Total margin: 2400 USD").toMatch(TOTALS);
    expect("Collateral (combined): 1100").toMatch(TOTALS);
    expect("Free collateral on this venue").not.toMatch(TOTALS);
  }, 30_000);
});
