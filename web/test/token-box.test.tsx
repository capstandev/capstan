// R2: the token-address box is absent while contracts.json has no CPST address, and shows the exact address (with
// the copy button and the explorer link) on the home page once it does. The address comes only from contracts.json.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configFromEnv } from "../src/config";
import { TOKEN_LINE } from "../src/copy";
import { CONTRACTS, cpstOn, type ContractsJson } from "../src/lib/contracts";
import { decorate } from "../src/site/decorate";

const ADDR = "0x00000000000000000000000000000000000000c4";
const deployed = (chain: string, address: string): ContractsJson => ({ generatedBy: "ops/ci/gen-deployments.ts", cpst: { [chain]: { address, symbol: "CPST", decimals: 18, supply: "1000000000" } } });
const home = () => (document.body.innerHTML = `<main class="bl-page"><section class="bl-hero"></section><section class="bl-integrations"></section></main>`);

describe("token box", () => {
  test("hidden-until-deployed", () => {
    const onDisk = JSON.parse(readFileSync(join(import.meta.dir, "../public/contracts.json"), "utf8"));
    expect(CONTRACTS).toEqual(onDisk);
    expect(onDisk.generatedBy).toBe("ops/ci/gen-deployments.ts");
    const cfg = configFromEnv({});

    // nothing deployed: no box
    home();
    decorate(cfg, "index", document, { generatedBy: "ops/ci/gen-deployments.ts", cpst: {} });
    expect(document.querySelector("[data-token-box]")).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN_LINE);
    if (!cpstOn(4663)) {
      home();
      decorate(cfg, "index");
      expect(document.querySelector("[data-token-box]")).toBeNull();
    }

    // deployed on 4663: right after the hero, the exact address, the copy button, the explorer link
    home();
    decorate(cfg, "index", document, deployed("4663", ADDR));
    const box = document.querySelector(".bl-hero + [data-token-box]")!;
    expect(box).not.toBeNull();
    expect(box.querySelector("h3")!.textContent).toBe(TOKEN_LINE);
    expect(box.querySelector("[data-token-address]")!.textContent).toBe(ADDR);
    expect(box.querySelector("button")!.textContent).toBe("Copy the token address");
    expect(box.querySelector("a")!.getAttribute("href")).toBe(`https://robinhoodchain.blockscout.com/token/${ADDR}`);
    // only the home page
    home();
    decorate(cfg, "pricing", document, deployed("4663", ADDR));
    expect(document.querySelector("[data-token-box]")).toBeNull();

    // another chain's entry, or a malformed address, keeps it hidden
    for (const d of [deployed("46630", ADDR), deployed("4663", "0x1234"), deployed("4663", "")]) {
      home();
      decorate(cfg, "index", document, d);
      expect(document.querySelector("[data-token-box]")).toBeNull();
    }
    document.body.innerHTML = "";

    // one source: no address literal in the box code or its data module
    for (const f of ["../src/site/decorate.ts", "../src/site/render.ts", "../src/lib/contracts.ts"]) expect(readFileSync(join(import.meta.dir, f), "utf8")).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});
