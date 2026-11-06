// Test-only wallets derived from public label strings (worthless by design). Shared with the api route tests, which
// must not name key material themselves (apps/* identifier rule).
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function testWallet(label: string) {
  return privateKeyToAccount(keccak256(toHex(`capstan policy test wallet: ${label}`))); // test-key
}
export type TestWallet = ReturnType<typeof testWallet>;

/** Receipt signer for route tests, derived from a public label (worthless by design). */
export async function testReceiptSigner() {
  const { nobleSigner } = await import("@capstan/receipts");
  const { hexToBytes } = await import("viem");
  return nobleSigner(hexToBytes(keccak256(toHex("capstan policy test receipt signer")))); // test-key
}
