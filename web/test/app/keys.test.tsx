// R7: through a full onboarding and an order, no key material reaches the DOM, localStorage, sessionStorage or the
// network. The key store's randomness is recorded, so every secret it ever made is known and searched for.
import { describe, expect, test } from "bun:test";
import { addressOfSecret, newSecretKey } from "../../../packages/sdk/src/keys/secp";
import { byText, click, waitFor } from "../helpers";
import { go, onboard, startDash } from "./harness";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

function storageDump(s: Storage): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)!;
    out.push(k, s.getItem(k) ?? "");
  }
  return out.join("\n");
}

describe("keys", () => {
  test("no-leak", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const d = await startDash();
    try {
      await onboard(d);
      const agent = d.m.host.querySelector("[data-agent-address]")!.textContent!.toLowerCase();
      expect(agent).toMatch(/^0x[0-9a-f]{40}$/);
      await go(d, "Order");
      await click(await waitFor(() => byText(d.m.host, "button", "Check the order"), "the order ticket"));
      await click(await waitFor(() => byText(d.m.host, "button", "Sign and send"), "the checked preview", 15_000));
      const done = await waitFor(() => d.m.host.querySelector("[data-order-result]"), "the order result", 15_000);
      expect(done.textContent).toContain("Receipt r");

      // the secrets the key store made: each key is derived from a 48-byte random seed (noble's hash-to-field), so
      // the seed and the key it gives are both searched for (the 12-byte draws are AES nonces, the 10-byte ones refs)
      const seeds = d.random.filter((b) => b.length === 48);
      expect(seeds.length).toBeGreaterThanOrEqual(1);
      const secrets = [...seeds, ...seeds.map((seed) => newSecretKey(() => seed.slice()))];
      expect(secrets.every((k) => k.length === 32 || k.length === 48)).toBe(true);
      // the derived key is the one the store uses: its address is the agent address on the page
      expect(seeds.map((seed) => addressOfSecret(newSecretKey(() => seed.slice())).toLowerCase())).toContain(agent);
      const needles = secrets.flatMap((b) => [hex(b), hex(b).toUpperCase(), b64(b), Array.from(b).join(",")]);

      const dom = document.documentElement.outerHTML;
      const storage = `${storageDump(localStorage)}\n${storageDump(sessionStorage)}`;
      const network = d.requests.map((r) => `${r.url}\n${JSON.stringify(r.headers)}\n${r.body}\n${JSON.stringify(r.response ?? null)}`).join("\n");
      const wallet = d.wallet.calls.map((c) => JSON.stringify(c.params)).join("\n");
      expect(d.requests.length).toBeGreaterThan(5);
      for (const n of needles) {
        expect(dom.includes(n)).toBe(false);
        expect(storage.includes(n)).toBe(false);
        expect(network.includes(n)).toBe(false);
        expect(wallet.includes(n)).toBe(false);
      }
      // the stored records are sealed: the secret is not in IndexedDB in the clear either
      const idb = JSON.stringify([...d.idb.dbs.values()].map((db) => [...db.values()].map((st) => [...((st as unknown as { data?: Map<unknown, unknown> }).data?.values() ?? [])])));
      for (const n of needles) expect(idb.includes(n)).toBe(false);
      // no request body names a key-like field
      for (const r of d.requests) expect(r.body).not.toMatch(/"(private|secret|mnemonic|seed)[A-Za-z]*"\s*:/i);
      // the page shows the agent address (public) and the order's receipt, nothing else about the key
      expect(d.m.host.textContent).toContain("Receipt r");
    } finally {
      await d.stop();
    }
  }, 60_000);
});
