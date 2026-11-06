// The receipt shape comes from @capstan/schema (spec 11); this guards the draft type against drift.
import { expect, test } from "bun:test";
import type { Receipt } from "@capstan/schema";
import type { ReceiptDraft } from "../src";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const draftKeys: Equal<keyof ReceiptDraft, Exclude<keyof Receipt, "v" | "receiptId" | "ts" | "brand" | "prevReceiptHash" | "sig">> = true;
const sigShape: Equal<Receipt["sig"], { alg: "secp256k1-eip191"; signer: `0x${string}`; value: `0x${string}` }> = true;

test("schema-type-equality", () => {
  expect(draftKeys && sigShape).toBe(true);
});
