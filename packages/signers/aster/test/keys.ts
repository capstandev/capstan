// Test-only accounts derived from public strings (anyone can rebuild them; never funded). The derived key stays in
// memory inside viem's account object and is never printed or written.
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const testAccount = (label: "main" | "signer" | "builder") => privateKeyToAccount(keccak256(toBytes(`capstan-aster-tv-${label}`))); // test-key
