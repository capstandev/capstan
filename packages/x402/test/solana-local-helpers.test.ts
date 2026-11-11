// Tracker line 78 helpers, no validator needed: the genesis guard refuses devnet, mainnet and non-loopback RPCs,
// and the genesis account dumps have the SPL layouts the validator and the x402 SVM scheme expect.
import { describe, expect, test } from "bun:test";
import { ataOf, assertLocalGenesis, localMint, mintDecimals, tokenAccount, USDC_MINT } from "./helpers/solana-local";

describe("solana local proof helpers", () => {
  test("genesis-guard", () => {
    expect(() => assertLocalGenesis("http://127.0.0.1:25540", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).toThrow(/refusing/);
    expect(() => assertLocalGenesis("http://127.0.0.1:25540", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")).toThrow(/refusing/);
    expect(() => assertLocalGenesis("https://api.devnet.solana.com", "2vrSEsUo2XJYd1hv4AJruEP1XkUx5goyUg65HFbka1XC")).toThrow(/not a local RPC/);
    expect(() => assertLocalGenesis("http://127.0.0.1:25540", "2vrSEsUo2XJYd1hv4AJruEP1XkUx5goyUg65HFbka1XC")).not.toThrow();
  });

  test("account-layouts", async () => {
    const owner = "9DfFSTDQ49KyDcSnHZmqaBYFGMaMkBjrVmP9GDrrKsH6";
    const t = Buffer.from(tokenAccount(USDC_MINT, owner, 5_000_000n).data[0], "base64");
    expect(t.length).toBe(165);
    expect(t.readBigUInt64LE(64)).toBe(5_000_000n);
    expect(t[108]).toBe(1);
    const m = localMint(6);
    expect(m.space).toBe(82);
    expect(mintDecimals(m)).toBe(6);
    // the associated token account address is deterministic and differs per owner
    expect(await ataOf(owner)).toBe(await ataOf(owner));
    expect(await ataOf(owner)).not.toBe(await ataOf(USDC_MINT));
  });
});
