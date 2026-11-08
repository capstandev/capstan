// R9: with VITE_PROFILE=fork the app points at the local stack (API 22210) and the anvil fork (22245), shows a plain
// "Local test network" banner, and refuses every write from chain 4663. The chain is never switched for the user.
import { describe, expect, test } from "bun:test";
import { decorate } from "../../src/site/decorate";
import { configFromEnv } from "../../src/config";
import { byText, click, mount, waitFor } from "../helpers";
import { connect, onboard, startDash, testWallet, toConfirm } from "./harness";

describe("profile", () => {
  test("fork-only", async () => {
    const fork = configFromEnv({ VITE_PROFILE: "fork" });
    expect(fork.profile).toBe("fork");
    expect(fork.apiBase).toBe("http://127.0.0.1:22210/v1");
    expect(fork.rpcUrl).toBe("http://127.0.0.1:22245");
    expect(fork.writeChainDenylist).toEqual([4663]);
    expect(fork.writeChainAllowlist).not.toContain(4663);
    // the live profile is not the fork's
    const live = configFromEnv({});
    expect(live.profile).toBe("live");
    expect(live.writeChainDenylist).toEqual([]);

    // the banner (src/site/decorate.ts, on every page): plain text, no animation or badge class
    document.body.innerHTML = "<main class=\"bl-page\"></main>";
    decorate(fork, "about");
    const banner = document.querySelector("[data-fork-banner]")!;
    expect(banner.textContent).toBe("Local test network");
    expect(banner.className).toBe("cap-fork-banner");
    expect(banner.children.length).toBe(0);
    document.body.innerHTML = "<main class=\"bl-page\"></main>";
    decorate(live, "about");
    expect(document.querySelector("[data-fork-banner]")).toBeNull();
    document.body.innerHTML = "";

    // fork profile, wallet on chain 4663: connect warns, onboarding is refused before any prompt, no key kept
    const w = testWallet({ chainId: 4663 });
    // every fork rule from the env config; the API base is the test stack's and the pins are mainnet's (VITE_NETWORK=mainnet)
    const { apiBase: _api, ...forkRules } = fork;
    const forkCfg = { ...forkRules, network: "mainnet" as const };
    const d = await startDash({ wallet: w, config: forkCfg });
    try {
      await connect(d);
      expect(d.m.host.querySelector("[data-chain-refused]")!.textContent).toContain("chain 4663");
      const panel = await toConfirm(d);
      expect(panel.hasAttribute("data-confirm")).toBe(true);
      // the lines are shown; the wallet is not asked: the chain guard refuses at the prompt
      await click(byText(d.m.host, "button", "Continue to your wallet"));
      const err = await waitFor(() => d.m.host.querySelector("[data-onboarding-error]"), "the refusal");
      expect(err.textContent).toContain("chain 4663");
      expect(err.textContent).toContain("never signs a write from that chain");
      expect(w.signs()).toEqual([]);
      expect(w.calls.some((c) => c.method === "wallet_switchEthereumChain" || c.method === "wallet_addEthereumChain")).toBe(false);
      expect(await d.keystore.list()).toEqual([]);
    } finally {
      await d.stop();
    }

    // fork profile on the local chain: the same onboarding goes through
    const w2 = testWallet({ chainId: 31337 });
    const d2 = await startDash({ wallet: w2, config: forkCfg });
    try {
      await onboard(d2);
      expect(w2.signs().length).toBeGreaterThanOrEqual(2);
      expect(w2.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(false);
    } finally {
      await d2.stop();
    }

    // live profile on chain 4663 is allowed (Hyperliquid user-signed actions sign on the wallet's own chain)
    const w3 = testWallet({ chainId: 4663 });
    const d3 = await startDash({ wallet: w3 });
    try {
      await onboard(d3);
      expect(w3.signs().length).toBeGreaterThanOrEqual(2);
      expect(w3.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(false);
    } finally {
      await d3.stop();
    }
  }, 60_000);
});
