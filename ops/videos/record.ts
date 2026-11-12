// Demo clips for the marketing kit, recorded with Playwright against the site and API on the FORK stack
// (ops/fork/up.sh with FORK_WEB=dist, after every-tx.ts S1 and S3 wrote the deployment and the web pins). Nothing here
// talks to a real chain: the site reads the fork RPC, the venues are the fork's stand-ins. The wallet is an
// in-process throwaway key (seed-derived from a label, as the web tests do) announced over EIP-6963 as "Web Wallet",
// with an on-page confirm sheet standing in for a browser wallet. Waits for the API are cut out of the clip; nothing is
// staged: every number on screen comes from the stack.
// Usage (from the repo root): bun ops/videos/record.ts --out <dir> [--only 00-overview,03-risk-panel] [--device phone]
// Writes <name>-<device>.mp4 per clip, contact-sheet.png (one frame per clip) and clips.json into --out.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { addressOfSecret, personalDigest, signDigestRsv } from "../../packages/sdk/src/keys/secp";
import { typedDataDigest } from "../../packages/sdk/src/wallet";
import { testKey } from "../../packages/sdk/test/helpers";
import { waitForPreloader, withBrowser } from "../../web/test/browser";
import { PORTS } from "../fork/lib";
import { anchorCurrentHour } from "./anchor";
import { CLIPS, type Clip, type Device } from "./clips";

const argv = process.argv.slice(2);
const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const OUT = resolve(arg("--out") ?? "videos-out");
const ONLY = arg("--only")?.split(",") ?? null;
const ONLY_DEVICE = arg("--device") as Device | undefined;
const SITE = process.env.CAPSTAN_FORK_SITE ?? `http://127.0.0.1:${PORTS.web}`;
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const RAW = join(OUT, ".raw");
const FRAMES = join(OUT, ".frames"); // one still per clip for the contact sheet (kept between partial runs)

// Playwright's screencast records CSS pixels (deviceScaleFactor does not reach the video), so each clip is captured at
// the viewport size and scaled to the delivery size on encode. Phone clips are real mobile renders at 390 px (touch,
// mobile layout), upscaled to 1080 x 1920: they read softer than a native phone capture.
const VIEW: Record<Device, { viewport: { width: number; height: number }; out: { width: number; height: number }; mobile: boolean; scale: number }> = {
  desktop: { viewport: { width: 1280, height: 720 }, out: { width: 1920, height: 1080 }, mobile: false, scale: 1 },
  phone: { viewport: { width: 390, height: 693 }, out: { width: 1080, height: 1920 }, mobile: true, scale: 3 },
};

/** Captions, cursor, tap marks and the wallet sheet, injected into every document of a recording. */
export function pageInit(o: { phone: boolean }) {
  const w = window as unknown as Record<string, unknown> & { __vidWallet(m: string, p: string): Promise<string> };
  const css = `
#vid-cap{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483646;background:rgba(17,24,39,.9);color:#fff;
 font:600 ${o.phone ? 17 : 26}px/1.3 -apple-system,"Helvetica Neue",Arial,sans-serif;padding:${o.phone ? "10px 14px" : "14px 26px"};
 border-radius:10px;${o.phone ? "top:44px" : "bottom:36px"};max-width:${o.phone ? "88%" : "76%"};text-align:center;pointer-events:none}
#vid-cap:empty{display:none}
#vid-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .05s linear}
.vid-tap{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(17,24,39,.28);
 z-index:2147483647;pointer-events:none;transition:opacity .35s ease-out}
#vid-sheet{position:fixed;z-index:2147483645;background:#fff;color:#111827;font:14px/1.4 -apple-system,"Helvetica Neue",Arial,sans-serif;
 box-shadow:0 12px 40px rgba(0,0,0,.28);${o.phone ? "left:0;right:0;bottom:0;border-radius:16px 16px 0 0;padding:18px 18px 26px" : "top:14px;right:18px;width:360px;border-radius:12px;padding:16px 18px"}}
#vid-sheet h4{margin:0 0 2px;font-size:12px;color:#6b7280;font-weight:600}
#vid-sheet h3{margin:0 0 10px;font-size:17px}
#vid-sheet ul{margin:0 0 14px;padding:0;list-style:none;font:12px/1.45 ui-monospace,Menlo,monospace;color:#374151;word-break:break-all}
#vid-sheet .row{display:flex;gap:10px}
#vid-sheet button{flex:1;border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:10px;font:600 14px -apple-system,Arial,sans-serif}
#vid-sheet button.ok{background:#1f2937;color:#fff;border-color:#1f2937}
#vid-sheet button.down{background:#000}`;
  const ready = () => {
    if (document.getElementById("vid-style")) return;
    const s = document.createElement("style");
    s.id = "vid-style";
    s.textContent = css;
    document.head.appendChild(s);
    const cap = document.createElement("div");
    cap.id = "vid-cap";
    cap.textContent = sessionStorage.getItem("vid-cap") ?? "";
    document.body.appendChild(cap);
    if (!o.phone) {
      const c = document.createElement("div");
      c.id = "vid-cursor";
      c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10 13 L16 13 Z" fill="#111" stroke="#fff" stroke-width="1.4"/></svg>';
      const xy = (sessionStorage.getItem("vid-xy") ?? "800,450").split(",");
      c.style.transform = `translate(${xy[0]}px,${xy[1]}px)`;
      document.body.appendChild(c);
      document.addEventListener("mousemove", (e) => {
        c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
        sessionStorage.setItem("vid-xy", `${e.clientX},${e.clientY}`);
      }, true);
    } else {
      document.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        if (!t) return;
        const d = document.createElement("div");
        d.className = "vid-tap";
        d.style.left = `${t.clientX}px`;
        d.style.top = `${t.clientY}px`;
        document.body.appendChild(d);
        setTimeout(() => (d.style.opacity = "0"), 180);
        setTimeout(() => d.remove(), 600);
      }, true);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
  w.__vidCaption = (t: string) => {
    sessionStorage.setItem("vid-cap", t);
    ready();
    document.getElementById("vid-cap")!.textContent = t;
  };
  const short = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 46 ? `${s.slice(0, 22)}...${s.slice(-12)}` : s;
  };
  const sheet = (title: string, lines: string[]) =>
    new Promise<void>((done) => {
      ready();
      const el = document.createElement("div");
      el.id = "vid-sheet";
      el.innerHTML = `<h4>Web Wallet</h4><h3></h3><ul></ul><div class="row"><button>Reject</button><button class="ok">Confirm</button></div>`;
      el.querySelector("h3")!.textContent = title;
      const ul = el.querySelector("ul")!;
      for (const l of lines) {
        const li = document.createElement("li");
        li.textContent = l;
        ul.appendChild(li);
      }
      document.body.appendChild(el);
      const ok = el.querySelector<HTMLButtonElement>("button.ok")!;
      setTimeout(() => {
        const r = ok.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const c = document.getElementById("vid-cursor");
        if (c) {
          c.style.transition = "transform .6s ease-in-out";
          c.style.transform = `translate(${x}px,${y}px)`;
          sessionStorage.setItem("vid-xy", `${x},${y}`);
        } else {
          const d = document.createElement("div");
          d.className = "vid-tap";
          d.style.left = `${x}px`;
          d.style.top = `${y}px`;
          setTimeout(() => document.body.appendChild(d), 500);
          setTimeout(() => d.remove(), 1000);
        }
      }, 800);
      setTimeout(() => ok.classList.add("down"), 1450);
      setTimeout(() => {
        el.remove();
        const c = document.getElementById("vid-cursor");
        if (c) c.style.transition = "transform .05s linear";
        done();
      }, 1700);
    });
  const call = async (method: string, params: unknown[]) => {
    const j = JSON.parse(await w.__vidWallet(method, JSON.stringify(params))) as { result?: unknown; error?: { message: string; code: number } };
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  const provider = {
    async request(a: { method: string; params?: unknown[] }) {
      const params = a.params ?? [];
      const connected = sessionStorage.getItem("vid-connected") === "1";
      if (a.method === "eth_accounts") return connected ? call(a.method, params) : [];
      if (a.method === "eth_requestAccounts") {
        if (!connected) {
          const acct = (await call("eth_accounts", [])) as string[];
          await sheet("Connect to this site", [`Site: ${location.host}`, `Account: ${acct[0]}`, "Lets the site see your address and ask for signatures."]);
          sessionStorage.setItem("vid-connected", "1");
        }
        return call(a.method, params);
      }
      if (a.method === "eth_signTypedData_v4") {
        const td = JSON.parse(String(params[1])) as { domain?: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
        const lines = [`${String(td.domain?.name ?? "")} (chain ${String(td.domain?.chainId ?? "-")})`, `Type: ${td.primaryType}`];
        for (const [k, v] of Object.entries(td.message).slice(0, 5)) lines.push(`${k}: ${short(v)}`);
        await sheet("Signature request", lines);
      } else if (a.method === "personal_sign") {
        const hex = String(params[0]).slice(2);
        const text = new TextDecoder().decode(Uint8Array.from((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16))));
        await sheet("Sign message", text.split("\n").filter(Boolean).slice(0, 6).map((l) => (l.length > 60 ? `${l.slice(0, 57)}...` : l)));
      } else if (a.method === "eth_sendTransaction") {
        const tx = (params[0] ?? {}) as Record<string, unknown>;
        await sheet("Confirm transaction", [`To: ${short(tx.to)}`, `Value: ${String(tx.value ?? "0")}`]);
      }
      return call(a.method, params);
    },
  };
  const announce = () =>
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "web-wallet-demo", name: "Web Wallet", icon: "data:image/svg+xml,", rdns: "demo.webwallet" }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}

/** The throwaway wallet behind the sheet: a seed-derived test key, as the web tests use (never a real key). */
export function demoWallet(label: string, chainId = 31337) {
  const k = testKey(label); // test-key (seed-derived)
  const owner = addressOfSecret(k).toLowerCase();
  return {
    owner,
    async request(method: string, params: unknown[]): Promise<unknown> {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [owner];
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (method === "eth_signTypedData_v4") {
        const td = JSON.parse(String(params[1])) as { types: Record<string, unknown> };
        const { EIP712Domain: _d, ...types } = td.types;
        return signDigestRsv(typedDataDigest({ ...td, types } as never), k);
      }
      if (method === "personal_sign") {
        const hex = String(params[0]).slice(2);
        return signDigestRsv(personalDigest(new TextDecoder().decode(Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16))))), k);
      }
      throw Object.assign(new Error(`unsupported method ${method}`), { code: 4200 });
    },
  };
}

/** One recording: keep() and skip() mark which seconds of the raw video stay in the clip. */
class Take {
  readonly t0 = Date.now();
  keepFrom: number | null = null;
  readonly keeps: [number, number][] = [];
  errors: string[] = [];
  constructor(readonly page: Page, readonly device: Device) {}
  private now() {
    return (Date.now() - this.t0) / 1000;
  }
  on() {
    if (this.keepFrom === null) this.keepFrom = this.now();
  }
  off() {
    if (this.keepFrom !== null) this.keeps.push([this.keepFrom, this.now()]);
    this.keepFrom = null;
  }
  /** Run fn off camera (waits for the API, navigation, setup). */
  async skip<T>(fn: () => Promise<T>): Promise<T> {
    const was = this.keepFrom !== null;
    this.off();
    const r = await fn();
    await this.page.waitForTimeout(250);
    if (was) this.on();
    return r;
  }
  hold(ms: number) {
    return this.page.waitForTimeout(ms);
  }
  caption(text: string) {
    return this.page.evaluate((t) => (window as unknown as { __vidCaption(t: string): void }).__vidCaption(t), text);
  }
  async goto(path: string) {
    await this.page.goto(`${SITE}${path}`, { waitUntil: "networkidle" });
    await waitForPreloader(this.page);
    await this.page.waitForTimeout(400);
  }
  async show(loc: Locator, block: "center" | "start" = "center") {
    await loc.first().evaluate((el, b) => el.scrollIntoView({ behavior: "smooth", block: b as ScrollLogicalPosition }), block);
    await this.hold(800);
  }
  async press(loc: Locator) {
    const l = loc.first();
    await l.scrollIntoViewIfNeeded();
    if (this.device === "phone") {
      await this.hold(250);
      await l.tap();
    } else {
      const b = await l.boundingBox();
      if (b) await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
      await this.hold(200);
      await l.click();
    }
  }
  async waitFor(sel: string, timeout = 90_000) {
    await this.skip(() => this.page.locator(sel).first().waitFor({ timeout }));
  }
}

const alertOf = async (p: Page, scope = "[data-live=trade]") => ((await p.locator(`${scope} [role=alert]`).first().textContent().catch(() => null)) ?? "").trim();
const nav = (t: Take, name: string) => t.press(t.page.getByRole("navigation", { name: "Dashboard", exact: true }).getByRole("link", { name, exact: true }));

async function openTrade(t: Take) {
  await t.skip(async () => {
    await t.goto("/dashboard");
    await t.page.locator('.dash-nav[data-view="trade"]').click();
    await t.page.waitForTimeout(500);
  });
}
async function connect(t: Take) {
  await t.press(t.page.getByRole("button", { name: "Connect Web Wallet" }));
  await t.waitFor("[data-connected]");
}
async function onboard(t: Take, venue: string, opts: { holdSteps?: number; agentSafe?: boolean } = {}) {
  // the venue link on the Connect screen opens that venue's onboarding with the owner known
  await nav(t, "Connect");
  await t.hold(400);
  await t.press(t.page.getByRole("link", { name: venue, exact: true }));
  await t.skip(() => t.page.getByText("Free agent slots").first().waitFor({ timeout: 60_000 }));
  await t.hold(800);
  if (opts.agentSafe) {
    const box = t.page.getByLabel(/Agent-safe mode/);
    await t.press(box);
    if (!(await box.isChecked())) throw new Error("agent-safe mode did not turn on");
    await t.hold(700);
  }
  await t.press(t.page.getByRole("button", { name: /Start onboarding/ }));
  await t.waitFor("[data-confirm], [data-live=trade] [role=alert]");
  if (!(await t.page.locator("[data-confirm]").count())) throw new Error(`onboarding ${venue}: ${await alertOf(t.page)}`);
  await t.show(t.page.locator("[data-confirm]"), "start");
  await t.hold(opts.holdSteps ?? 2500);
  await t.press(t.page.getByRole("button", { name: "Continue to your wallet" }));
  // the wallet sheets play on camera; the API round trips between them are short
  await t.page.locator("[data-delegation], [data-live=trade] [role=alert]").first().waitFor({ timeout: 120_000 });
  if (!(await t.page.locator("[data-delegation]").count())) throw new Error(`onboarding ${venue} failed: ${await alertOf(t.page)}`);
  await t.show(t.page.locator("[data-delegation]"));
}
async function quote(t: Take) {
  await nav(t, "Quote");
  await t.hold(500);
  await t.press(t.page.getByRole("button", { name: "Get quote" }));
  await t.waitFor("[data-quote-table], [data-live=trade] [role=alert]");
  if (!(await t.page.locator("[data-quote-table]").count())) throw new Error(`quote: ${await alertOf(t.page)}`);
  await t.show(t.page.locator("[data-quote-table]"));
}
async function order(t: Take): Promise<string> {
  await nav(t, "Order");
  await t.hold(500);
  await t.press(t.page.getByRole("button", { name: "Check the order" }));
  await t.waitFor("[data-order-preview], [data-screen=order] [role=alert]");
  if (await t.page.locator("[data-screen=order] [role=alert]").count()) throw new Error(`order check: ${await alertOf(t.page, "[data-screen=order]")}`);
  await t.show(t.page.locator("[data-order-preview]"));
  await t.hold(700);
  await t.press(t.page.getByRole("button", { name: "Sign and send" }));
  await t.waitFor("[data-order-result], [data-screen=order] [role=alert]");
  if (!(await t.page.locator("[data-order-result]").count())) throw new Error(`order send: ${await alertOf(t.page, "[data-screen=order]")}`);
  await t.show(t.page.locator("[data-order-result]"));
  return (await t.page.locator("[data-order-result] a").first().textContent())!.trim();
}
async function verify(t: Take, receiptId: string) {
  const a = await t.skip(async () => {
    const r = await anchorCurrentHour();
    await t.goto(`/verify?id=${encodeURIComponent(receiptId)}`);
    return r;
  });
  try {
    await t.caption("Receipt checked in the browser against the anchor contract on the fork");
    await t.press(t.page.getByRole("button", { name: "Verify" }));
    await t.waitFor("[data-verify-result]");
    const result = await t.page.locator("[data-verify-result]").getAttribute("data-verify-result");
    if (result !== "valid") throw new Error(`verify: ${result} (anchor ${a.status})`);
    await t.show(t.page.locator("[data-verify-result]"));
    await t.hold(1600);
  } finally {
    await t.skip(() => a.undo());
  }
}
async function endCard(t: Take) {
  await t.skip(async () => {
    await t.goto("/");
    const logo = await t.page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? "");
    await t.page.evaluate((src) => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;inset:0;z-index:2147483600;background:#eaf4fb;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:#0f2a44";
      d.innerHTML = `${src ? `<img src="${src}" style="width:96px;height:96px">` : ""}<div style="font-size:44px;font-weight:700">Capstan</div><div style="font-size:20px">One API for on-chain perps</div><div style="font-size:18px;opacity:.75">get-capstan.com/docs</div>`;
      document.body.appendChild(d);
    }, logo);
  });
  await t.caption("Demo on a copy of mainnet");
  await t.hold(2300);
}

type Flow = (t: Take) => Promise<void>;
const FLOWS: Record<string, Flow> = {
  "00-overview": async (t) => {
    await t.skip(() => t.goto("/"));
    t.on();
    await t.caption("One API for perps across venues");
    await t.hold(t.device === "phone" ? 1800 : 1300);
    if (t.device === "desktop") {
      await t.page.evaluate(() => window.scrollBy({ top: 420, behavior: "smooth" }));
      await t.hold(900);
    }
    await openTrade(t);
    await t.skip(async () => {
      await t.page.getByRole("button", { name: "Connect Web Wallet" }).click();
      await t.page.locator("[data-connected]").waitFor({ timeout: 60_000 });
    });
    await t.caption("Every cost, per venue, before you sign");
    await quote(t);
    await t.hold(800);
    await t.caption("Your trade-only key is made on your device");
    await onboard(t, "Hyperliquid", { holdSteps: 600 });
    await t.hold(300);
    await t.caption("Every routed order gets a signed receipt");
    const id = await order(t);
    await t.hold(600);
    await verify(t, id);
    await endCard(t);
  },
  "01-quote-compare": async (t) => {
    await openTrade(t);
    await t.skip(async () => {
      await t.page.getByRole("button", { name: "Connect Web Wallet" }).click();
      await t.page.locator("[data-connected]").waitFor({ timeout: 60_000 });
    });
    t.on();
    await t.caption("One quote request across the venues Capstan routes to");
    await nav(t, "Quote");
    await t.hold(1200);
    const size = t.page.getByLabel("Size", { exact: true });
    if (await size.count()) {
      await t.press(size);
      await size.fill("");
      await size.pressSequentially("0.05", { delay: 90 });
    }
    await t.hold(600);
    await t.press(t.page.getByRole("button", { name: "Get quote" }));
    await t.waitFor("[data-quote-table], [data-live=trade] [role=alert]");
    if (!(await t.page.locator("[data-quote-table]").count())) throw new Error(`quote: ${await alertOf(t.page)}`);
    const legs = await t.page.locator("[data-quote-table] tbody tr").count();
    await t.caption("Venue fee, builder fee, slippage, funding and liquidation, per venue");
    await t.show(t.page.locator("[data-quote-table]"));
    if (t.device === "phone") {
      for (let i = 0; i < 3; i++) {
        await t.page.evaluate(() => window.scrollBy({ top: 260, behavior: "smooth" }));
        await t.hold(1600);
      }
    } else await t.hold(4000);
    if (legs > 1) {
      await t.caption("A venue that cannot take the order says why");
      await t.hold(3500);
    }
    await t.caption("Demo on a copy of mainnet, stand-in venue books");
    await t.hold(2500);
  },
  "02-onboard-hyperliquid": (t) => onboardClip(t, "Hyperliquid"),
  "03-risk-panel": async (t) => {
    await readyAccount(t, "Hyperliquid");
    await t.skip(async () => {
      await t.page.locator('.dash-nav[data-view="risk"]').click();
      await t.page.waitForTimeout(600);
    });
    t.on();
    await t.caption("Risk, read venue by venue");
    await t.hold(1500);
    await t.press(t.page.getByRole("button", { name: /Read my venue accounts/ }));
    await t.waitFor("[data-risk-view], [data-live=risk] [role=alert]");
    if (!(await t.page.locator("[data-risk-view]").count())) throw new Error(`risk: ${await alertOf(t.page, "[data-live=risk]")}`);
    await t.show(t.page.locator("[data-risk-view]"), "start");
    await t.caption("Each venue liquidates on its own. Margin is never pooled");
    await t.hold(4000);
    await t.page.evaluate(() => window.scrollBy({ top: 360, behavior: "smooth" }));
    await t.hold(3000);
    await t.caption("Demo on a copy of mainnet");
    await t.hold(2500);
  },
  "04-spread-plan": async (t) => {
    await readyAccount(t, "Hyperliquid");
    await t.skip(() => onboardQuiet(t, "Lighter"));
    t.on();
    await t.caption("Funding-rate spread trades are marked at-risk");
    await nav(t, "Spreads");
    await t.hold(1500);
    await t.press(t.page.getByRole("button", { name: "Scan pairs" }));
    await t.waitFor("[data-scan] li, [data-screen=spreads] [role=alert]");
    if (!(await t.page.locator("[data-scan] li").count())) throw new Error(`scan: ${await alertOf(t.page, "[data-screen=spreads]")}`);
    await t.caption("Demo data: funding from stand-in venues on a copy of mainnet");
    await t.show(t.page.locator("[data-scan]"));
    await t.hold(2000);
    await t.press(t.page.locator("[data-scan] li").first().getByRole("button", { name: "Use" }));
    await t.hold(800);
    await t.press(t.page.getByRole("button", { name: "Make a plan" }));
    await t.waitFor("[data-plan], [data-screen=spreads] [role=alert]");
    if (!(await t.page.locator("[data-plan]").count())) throw new Error(`plan: ${await alertOf(t.page, "[data-screen=spreads]")}`);
    await t.caption("The plan shows legs, breakeven and what happens if a hedge fails");
    await t.show(t.page.locator("[data-plan]"), "start");
    await t.hold(3500);
    await t.show(t.page.locator("[data-ack-box]"));
    await t.caption("Nothing runs until you read the risk label and sign the acknowledgement");
    await t.press(t.page.locator("[data-ack-box]"));
    await t.hold(1000);
    await t.press(t.page.getByRole("button", { name: "Sign the acknowledgement" }));
    await t.page.getByRole("button", { name: "Acknowledgement signed" }).waitFor({ timeout: 60_000 });
    await t.hold(2500);
  },
  "05-kill-switch": async (t) => {
    await openTrade(t);
    await t.skip(async () => {
      await t.page.getByRole("button", { name: "Connect Web Wallet" }).click();
      await t.page.locator("[data-connected]").waitFor({ timeout: 60_000 });
    });
    t.on();
    // agent-safe onboarding (policy) answered 500 on the fork stack at 04d1f0b, so this clip shows the kill switch on a
    // relay-mode key and makes no policy claim
    await t.caption("Each trade-only key has a kill switch");
    await onboard(t, "Hyperliquid", { holdSteps: 1500 });
    await t.hold(1000);
    await t.caption("One click stops the key");
    await nav(t, "Policy and kill");
    await t.hold(1000);
    await t.press(t.page.getByRole("button", { name: "Kill this key" }));
    await t.waitFor("[data-kill-result], [data-live=trade] [role=alert]");
    if (!(await t.page.locator("[data-kill-result]").count())) throw new Error(`kill: ${await alertOf(t.page)}`);
    await t.show(t.page.locator("[data-kill-result]"), "start");
    await t.caption("Capstan's relay refuses the key; the revocation steps are listed");
    await t.hold(4500);
  },
};

async function onboardClip(t: Take, venue: string) {
  await openTrade(t);
  t.on();
  await t.caption(`Onboarding ${venue}: connect your wallet`);
  await connect(t);
  await t.hold(800);
  await t.caption("Plain-English steps first. The trade-only key is made in this browser");
  await onboard(t, venue, { holdSteps: 4500 });
  await t.caption("Each signature is shown before you approve it. None can withdraw or transfer");
  await t.hold(3500);
  await t.caption("Demo on a copy of mainnet, stand-in venue");
  await t.hold(2000);
}
async function onboardQuiet(t: Take, venue: string) {
  await t.page.getByRole("navigation", { name: "Dashboard", exact: true }).getByRole("link", { name: "Connect", exact: true }).click();
  await t.page.getByRole("link", { name: venue, exact: true }).click();
  await t.page.getByText("Free agent slots").first().waitFor({ timeout: 60_000 });
  await t.page.getByRole("button", { name: /Start onboarding/ }).click();
  await t.page.locator("[data-confirm]").waitFor({ timeout: 90_000 });
  await t.page.getByRole("button", { name: "Continue to your wallet" }).click();
  await t.page.locator("[data-delegation], [data-live=trade] [role=alert]").first().waitFor({ timeout: 120_000 });
  if (!(await t.page.locator("[data-delegation]").count())) throw new Error(`onboarding ${venue} failed: ${await alertOf(t.page)}`);
}
/** Off camera: connect and onboard, so the clip starts at the state it shows. */
async function readyAccount(t: Take, venue: string) {
  await openTrade(t);
  await t.skip(async () => {
    await t.page.getByRole("button", { name: "Connect Web Wallet" }).click();
    await t.page.locator("[data-connected]").waitFor({ timeout: 60_000 });
    await onboardQuiet(t, venue);
  });
}

function sh(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.toString().slice(-600)}`);
  return r.stdout.toString();
}

/** Raw webm -> H.264 mp4 at 30 fps with only the kept seconds. Returns the largest frame gap in seconds. */
function encode(raw: string, mp4: string, keeps: [number, number][], device: Device): { seconds: number; maxGap: number } {
  const sel = keeps.filter(([a, b]) => b - a > 0.05).map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");
  const { width, height } = VIEW[device].out;
  sh([FFMPEG, "-y", "-loglevel", "error", "-i", raw, "-vf", `select='${sel}',setpts=N/25/TB,fps=30,scale=${width}:${height}:flags=lanczos,format=yuv420p`, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", mp4]);
  const pts = sh([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", mp4]).trim().split("\n").map((l) => Number.parseFloat(l));
  let maxGap = 0;
  for (let i = 1; i < pts.length; i++) if (Number.isFinite(pts[i]) && Number.isFinite(pts[i - 1])) maxGap = Math.max(maxGap, pts[i]! - pts[i - 1]!);
  return { seconds: pts.length / 30, maxGap };
}

async function recordOne(browser: Browser, clip: Clip, device: Device): Promise<Record<string, unknown>> {
  const v = VIEW[device];
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.scale, isMobile: v.mobile, hasTouch: v.mobile, recordVideo: { dir: RAW, size: v.viewport } });
  const wallet = demoWallet(`video-${clip.name}-${device}-${Date.now()}`);
  await ctx.exposeFunction("__vidWallet", async (m: string, p: string) => {
    try {
      return JSON.stringify({ result: await wallet.request(m, JSON.parse(p) as unknown[]) });
    } catch (e) {
      return JSON.stringify({ error: { message: (e as Error).message, code: (e as { code?: number }).code ?? -32603 } });
    }
  });
  await ctx.addInitScript(pageInit, { phone: device === "phone" });
  const page = await ctx.newPage();
  const t = new Take(page, device);
  page.on("pageerror", (e) => t.errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 404|MEDIA_ERR|DEMUXER|not supported/i.test(m.text())) t.errors.push(m.text());
  });
  let failure: string | null = null;
  try {
    await FLOWS[clip.name]!(t);
    t.off();
  } catch (e) {
    failure = (e as Error).message;
    t.off();
  }
  const video = page.video();
  await ctx.close();
  const raw = video ? await video.path() : null;
  const name = `${clip.name}-${device}`;
  if (!raw || failure) return { name, device, failure: failure ?? "no video", errors: t.errors };
  const kept = join(RAW, `${name}.webm`);
  renameSync(raw, kept);
  const mp4 = join(OUT, `${name}.mp4`);
  const { seconds, maxGap } = encode(kept, mp4, t.keeps, device);
  mkdirSync(FRAMES, { recursive: true });
  const frame = join(FRAMES, `${name}.png`);
  sh([FFMPEG, "-y", "-loglevel", "error", "-ss", String(Math.min(seconds * 0.6, seconds - 0.5)), "-i", mp4, "-frames:v", "1", frame]);
  return { name, device, seconds: Number(seconds.toFixed(1)), bytes: statSync(mp4).size, maxFrameGap: Number(maxGap.toFixed(4)), overLimit: seconds > clip.maxSeconds, errors: t.errors };
}

/** One frame per clip, labelled, on one page (rendered by the browser: no font filter needed in ffmpeg). */
async function contactSheet(browser: Browser, rows: Record<string, unknown>[]) {
  const ok = rows.filter((r) => !r.failure);
  if (!ok.length) return;
  const cells = ok
    .map((r) => {
      const png = readFileSync(join(FRAMES, `${r.name}.png`)).toString("base64");
      return `<figure><img src="data:image/png;base64,${png}"><figcaption>${String(r.name)} &middot; ${r.seconds} s &middot; ${(Number(r.bytes) / 1e6).toFixed(1)} MB</figcaption></figure>`;
    })
    .join("");
  const ctx = await browser.newContext({ viewport: { width: 2400, height: 800 } });
  const page = await ctx.newPage();
  await page.setContent(`<style>body{margin:0;padding:20px;background:#fff;font:600 20px -apple-system,Arial,sans-serif;display:flex;flex-wrap:wrap;gap:20px;align-items:flex-end}
figure{margin:0}img{height:440px;display:block;border:1px solid #ccc}figcaption{padding-top:8px}</style>${cells}`);
  await page.screenshot({ path: join(OUT, "contact-sheet.png"), fullPage: true });
  await ctx.close();
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  const manifest = join(OUT, "clips.json");
  let rows: Record<string, unknown>[] = [];
  try {
    rows = JSON.parse(readFileSync(manifest, "utf8")).clips ?? [];
  } catch {}
  await withBrowser(async (browser) => {
    for (const clip of CLIPS) {
      if (clip.source !== "fork" || (ONLY && !ONLY.includes(clip.name))) continue;
      for (const device of clip.devices) {
        if (ONLY_DEVICE && device !== ONLY_DEVICE) continue;
        const r = await recordOne(browser, clip, device);
        console.log(JSON.stringify(r));
        rows = rows.filter((x) => x.name !== r.name).concat(r);
      }
    }
  });
  // rows from an earlier run of a clip that is now held are dropped
  rows = rows.filter((r) => CLIPS.some((c) => c.source === "fork" && String(r.name).startsWith(`${c.name}-`)));
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  await withBrowser((browser) => contactSheet(browser, rows));
  const held = CLIPS.filter((c) => c.source === "held").map((c) => ({ name: c.name, reason: c.reason }));
  writeFileSync(manifest, `${JSON.stringify({ recordedAt: new Date().toISOString(), site: SITE, stack: "ops/fork/up.sh (FORK_WEB=dist) on an anvil fork of Robinhood Chain 4663 with stand-in venues", clips: rows, held }, null, 2)}\n`);
  if (process.env.VIDEOS_KEEP_RAW !== "1") rmSync(RAW, { recursive: true, force: true });
}

if (import.meta.main) await main();
