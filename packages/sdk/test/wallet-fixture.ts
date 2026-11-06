// The test user's MAIN wallet: a viem local account over a seed-derived test key, reached only through WalletSigner.
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "../src/bytes";
import { accountWallet, type WalletSigner } from "../src/wallet";
import { testKey } from "./helpers";

export function testWallet(label = "owner", confirm?: (lines: string[]) => Promise<boolean>): WalletSigner & { prompts: string[]; shown: string[][] } {
  const account = privateKeyToAccount(toHex(testKey(label))); // test-key (seed-derived)
  const prompts: string[] = [];
  const shown: string[][] = [];
  const w = accountWallet(account, undefined, { confirm: async (lines) => (shown.push(lines), confirm ? confirm(lines) : true) });
  return {
    ...w,
    prompts,
    shown,
    async signTypedData(td) {
      prompts.push(`typed:${td.primaryType}`);
      return w.signTypedData(td);
    },
    async signMessage(text) {
      prompts.push("message");
      return w.signMessage(text);
    },
  };
}
