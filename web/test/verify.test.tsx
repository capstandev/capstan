// R5: /verify checks a receipt produced by the local stack (the SDK test stack: the real Hyperliquid adapter and the
// real receipts library) and shows each check: signature, leaf, proof, hour and the on-chain root or "not posted yet".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, sdkClient } from "../../packages/sdk/test/stack";
import { Verify } from "../src/pages/Verify";
import type { Hex } from "../src/lib/capstan";
import { byText, click, mount, typeInto, waitFor } from "./helpers";

const RPC = "http://rpc.anchor.test";
const ANCHOR = "0x00000000000000000000000000000000000000a1" as Hex;

let stack: Awaited<ReturnType<typeof startStack>>;
let receiptId: string;
let posted: string | null = null;

/** fetch for the page: the anchor JSON-RPC is answered here (chain 31337, rootOf = `posted`), the rest goes to the stack. */
const pageFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(RPC)) {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = body.method === "eth_chainId" ? "0x7a69" : `0x${(posted ?? `0x${"0".repeat(64)}`).slice(2)}${"0".repeat(64)}${"0".repeat(63)}1`; // not-a-key
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }
  return fetch(input, init);
}) as typeof fetch;

beforeAll(async () => {
  stack = await startStack();
  const { client } = await sdkClient(stack);
  const r = await client.onboard("hyperliquid");
  receiptId = r.receiptId!;
});

afterAll(() => stack?.stop());

async function run(input: string) {
  const m = await mount(<Verify />, { path: "/verify", config: { apiBase: stack.apiBase, network: "mainnet", rpcUrl: RPC, receiptSigners: [stack.receiptSigner], anchorAddress: ANCHOR, anchorChainId: 31337, fetch: pageFetch } });
  await typeInto(m.host.querySelector("#receipt-input")!, input);
  await click(byText(m.host, "button", "Verify"));
  const res = await waitFor(() => m.host.querySelector<HTMLElement>("[data-verify-result]") ?? m.host.querySelector<HTMLElement>("[role=alert]"), "the result");
  const check = (k: string) => m.host.querySelector(`[data-check=${k}] dd`)?.textContent ?? null;
  const out = { result: res.getAttribute("data-verify-result"), signature: check("signature"), leaf: check("leaf"), proof: check("proof"), hour: check("hour"), root: check("root"), text: m.text() };
  await m.unmount();
  return out;
}

describe("verify", () => {
  test("local-receipt", async () => {
    expect(receiptId).toMatch(/^r\d{6}$/);
    // fresh receipt, hour not anchored yet
    posted = null;
    const a = await run(receiptId);
    expect(a).toMatchObject({ result: "valid", signature: "valid", leaf: "recomputed and matches", proof: "valid for the hourly root", hour: "the receipt's own hour", root: "not posted yet" });
    expect(a.text).toContain("The receipt is valid.");
    expect(a.text).toContain("It does not prove that a venue filled fairly.");

    // the hour's root is posted and equal: every check passes
    const proof = (await (await fetch(`${stack.apiBase}/receipts/${receiptId}/proof`)).json()) as { root: string };
    posted = proof.root;
    const b = await run(receiptId);
    expect(b).toMatchObject({ result: "valid", root: "matches the posted root" });

    // a different root on chain fails the receipt
    posted = `0x${"11".repeat(32)}`; // not-a-key
    const c = await run(receiptId);
    expect(c).toMatchObject({ result: "invalid", root: "differs from the posted root" });

    // pasted JSON with an edited fee line: signature and leaf both fail
    posted = null;
    const receipt = (await (await fetch(`${stack.apiBase}/receipts/${receiptId}`)).json()) as Record<string, unknown>;
    const d = await run(JSON.stringify({ ...receipt, venue: "aster" }));
    expect(d).toMatchObject({ result: "invalid", signature: "not valid", proof: "not valid" });

    // the untouched JSON verifies the same as the id
    const e = await run(JSON.stringify(receipt));
    expect(e).toMatchObject({ result: "valid", signature: "valid" });

    // bad input is explained, not crashed on
    const f = await run("not a receipt id!");
    expect(f.text).toContain("letters, digits, dashes and underscores");
  }, 60_000);
});
