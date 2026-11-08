// The one module every page loads (after the owner's app.js has drawn the page). It reads the build config, adds
// the fork banner and the risk disclaimer where the rules ask for them, shows the CPST token box once
// contracts.json has an address, and loads the live wiring for the page in view. Each page's code is its own chunk.
// Buffer for the SDK and the receipts library in the browser (signature recovery, leaves), before anything else
import "../polyfills";
import "./fonts.css";
import "./live.css";
import { configFromEnv } from "../config";
import { decorate, pageOf } from "./decorate";

async function start() {
  const cfg = configFromEnv(import.meta.env as unknown as Record<string, string | boolean | undefined>);
  const page = pageOf(document.body, location.pathname);
  decorate(cfg, page);
  switch (page) {
    case "dashboard":
      (await import("./dashboard")).startDashboard(cfg);
      break;
    case "markets":
      await (await import("./feature")).wireMarketsPage(cfg);
      break;
    case "quotes": {
      const [f, r] = await Promise.all([import("./feature"), import("./react")]);
      await f.wireQuotesPage(cfg, (el) => r.mountQuoteWidget(el, cfg));
      break;
    }
    case "risk": {
      const [f, r] = await Promise.all([import("./feature"), import("./react")]);
      f.wireRiskPage((el, onRisk) => r.mountRiskWidget(el, cfg, onRisk));
      break;
    }
    case "pricing":
      await (await import("./feature")).wirePricingPage(cfg);
      break;
    case "docs":
    case "verify":
    case "status":
    case "legal":
    case "404": {
      const el = document.getElementById("cap-live");
      if (el) (await import("./react")).mountPage(page, el, cfg);
      break;
    }
    default:
      break;
  }
}

void start();
