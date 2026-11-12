// make-solana.ts --payto-ata (ensureAta) with stand-in RPCs: no network, no real wallets.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSigner } from "@solana/kit";
import { ataAddress, ensureAta, TOKEN_PROGRAMS, USDC_DEVNET_MINT } from "../make-solana";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const RPC = "https://api.devnet.solana.com";
const PAYTO = "431KeCCVwY44n2c5pPJttmsi1trrKejishWYi2dNBgut";

function stubRpc(o: { genesis?: string; ataExists: boolean; status?: unknown }) {
  const methods: string[] = [];
  const f = async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    methods.push(b.method);
    const result = (() => {
      switch (b.method) {
        case "getGenesisHash":
          return o.genesis ?? DEVNET_GENESIS;
        case "getAccountInfo":
          return { value: b.params[0] === USDC_DEVNET_MINT ? { owner: TOKEN_PROGRAMS[0] } : o.ataExists ? { owner: TOKEN_PROGRAMS[0] } : null };
        case "getLatestBlockhash":
          return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
        case "sendTransaction":
          return "sig";
        case "getSignatureStatuses":
          return { value: [o.status ?? { confirmationStatus: "confirmed", err: null }] };
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { f, methods };
}

describe("sol-payto USDC account (make-solana.ts --payto-ata)", () => {
  test("derives the ATA the facilitator named in the 2026-11-12 run", async () => {
    expect(String(await ataAddress(PAYTO, USDC_DEVNET_MINT, TOKEN_PROGRAMS[0]))).toBe("4EHa4HUwcmZzF3R3PC1zzS3XhEYE8NFe7FuuLZZU1Rew");
  });

  test("idempotent: an existing account sends nothing", async () => {
    const payer = await generateKeyPairSigner();
    const { f, methods } = stubRpc({ ataExists: true });
    const r = await ensureAta({ owner: PAYTO, payer, rpc: RPC, f });
    expect(r).toEqual({ owner: PAYTO, ata: "4EHa4HUwcmZzF3R3PC1zzS3XhEYE8NFe7FuuLZZU1Rew", created: false, signature: null });
    expect(methods).not.toContain("sendTransaction");
  });

  test("missing account: one CreateIdempotent tx, fee and rent from the payer, then confirmation", async () => {
    const payer = await generateKeyPairSigner();
    const { f, methods } = stubRpc({ ataExists: false });
    const r = await ensureAta({ owner: PAYTO, payer, rpc: RPC, f, sleep: async () => {} });
    expect(r.created).toBe(true);
    expect(r.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(methods).toEqual(["getGenesisHash", "getAccountInfo", "getAccountInfo", "getLatestBlockhash", "sendTransaction", "getSignatureStatuses"]);
  });

  test("refuses mainnet: a mainnet host or genesis never gets a transaction", async () => {
    const payer = await generateKeyPairSigner();
    const { f, methods } = stubRpc({ ataExists: false, genesis: MAINNET_GENESIS });
    await expect(ensureAta({ owner: PAYTO, payer, rpc: RPC, f })).rejects.toThrow("not Solana devnet");
    await expect(ensureAta({ owner: PAYTO, payer, rpc: "https://api.mainnet-beta.solana.com", f })).rejects.toThrow();
    expect(methods).not.toContain("sendTransaction");
  });
});
