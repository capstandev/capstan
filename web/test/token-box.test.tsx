// R2: the token-address box is absent while contracts.json has no CPST address, and shows the exact address (with
// the copy button and the explorer link) once it does. The address comes only from contracts.json.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TokenAddressBox } from "../src/components/TokenAddressBox";
import { TOKEN_LINE } from "../src/copy";
import { CONTRACTS, cpstOn, type ContractsJson } from "../src/lib/contracts";
import { Landing } from "../src/pages/Landing";
import { mount } from "./helpers";

const ADDR = "0x00000000000000000000000000000000000000c4";
const deployed = (chain: string, address: string): ContractsJson => ({ generatedBy: "ops/ci/gen-deployments.ts", cpst: { [chain]: { address, symbol: "CPST", decimals: 18, supply: "1000000000" } } });

describe("token box", () => {
  test("hidden-until-deployed", async () => {
    // the shipped file is the generated one, read as is
    const onDisk = JSON.parse(readFileSync(join(import.meta.dir, "../public/contracts.json"), "utf8"));
    expect(CONTRACTS).toEqual(onDisk);
    expect(onDisk.generatedBy).toBe("ops/ci/gen-deployments.ts");

    // nothing deployed (today's file): no box anywhere on the landing page
    const empty = await mount(<Landing contracts={{ generatedBy: "ops/ci/gen-deployments.ts", cpst: {} }} />);
    expect(empty.host.querySelector("[data-token-box]")).toBeNull();
    expect(empty.text()).not.toContain(TOKEN_LINE);
    await empty.unmount();
    if (!cpstOn(4663)) {
      const real = await mount(<Landing />);
      expect(real.host.querySelector("[data-token-box]")).toBeNull();
      await real.unmount();
    }

    // deployed on 4663: the exact address, the copy button, the explorer link
    const m = await mount(<TokenAddressBox data={deployed("4663", ADDR)} />);
    const box = m.host.querySelector("[data-token-box]")!;
    expect(box).not.toBeNull();
    expect(box.querySelector("h2")!.textContent).toBe(TOKEN_LINE);
    expect(box.querySelector("[data-token-address]")!.textContent).toBe(ADDR);
    expect(box.querySelector("button")!.getAttribute("aria-label")).toBe("Copy the token address");
    expect(box.querySelector("a")!.getAttribute("href")).toBe(`https://robinhoodchain.blockscout.com/token/${ADDR}`);
    await m.unmount();

    // another chain's entry, or a malformed address, keeps the box hidden on this build's chain
    for (const d of [deployed("46630", ADDR), deployed("4663", "0x1234"), deployed("4663", "")]) {
      const x = await mount(<TokenAddressBox data={d} />);
      expect(x.host.querySelector("[data-token-box]")).toBeNull();
      await x.unmount();
    }

    // one source: no address literal in the box or its data module
    for (const f of ["../src/components/TokenAddressBox.tsx", "../src/lib/contracts.ts"]) expect(readFileSync(join(import.meta.dir, f), "utf8")).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});
