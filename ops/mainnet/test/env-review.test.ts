// todo 47 R3: every flag in the OFF list is off, every must-match value matches, no empty security setting.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFF_AT_FIRST_DEPLOY, parseEnv, review, reviewService, type Env } from "../env-review";
import { ROOT } from "../lib";

const SAFE = "0x1111111111111111111111111111111111111111";
const HL = "0x2222222222222222222222222222222222222222";
const ASTER = "0x3333333333333333333333333333333333333333";
const env = (s: string): Env => parseEnv(s);
const base = `CAPSTAN_NETWORK=mainnet\nRHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com\n`;
const kinds = (f: { kind: string; key: string }[]) => f.map((x) => `${x.kind}:${x.key}`).sort();

describe("env review", () => {
  test("flags-and-matches", () => {
    // the committed templates and overlays pass, with only pending inputs
    const r = review();
    expect(r.findings.filter((f) => f.kind === "fail")).toEqual([]);
    expect(r.services).toEqual(["anchor", "api", "facilitator", "mcp", "receipts", "relay", "workers", "ws"]);
    // every flag of the OFF list refuses any value but 0
    for (const k of OFF_AT_FIRST_DEPLOY) {
      expect(kinds(reviewService("api", env(`${base}${k}=1\n`), {}, { hyperliquid: null, aster: null }))).toEqual([`fail:${k}`]);
      expect(kinds(reviewService("api", env(`${base}${k}=0\n`), {}, { hyperliquid: null, aster: null }))).toEqual([]);
    }
    // must-match: VPS IP, builders = SDK pins, payTo = brand Safe
    const pins = { hyperliquid: HL, aster: ASTER };
    const good = env(`${base}RELAY_EGRESS_IP=203.0.113.7\nHL_BUILDER_ADDRESS=${HL}\nASTER_BUILDER_ADDRESS=${ASTER}\nX402_PAY_TO_EVM=${SAFE}\nX402_PAYTO_EVM=${SAFE}\n`);
    const inputs = { vpsIp: "203.0.113.7", brandSafe: SAFE };
    expect(reviewService("api", good, inputs, pins)).toEqual([]);
    expect(kinds(reviewService("api", good, { ...inputs, vpsIp: "203.0.113.8" }, pins))).toEqual(["fail:RELAY_EGRESS_IP"]);
    expect(kinds(reviewService("api", good, { ...inputs, brandSafe: HL }, pins))).toEqual(["fail:X402_PAYTO_EVM", "fail:X402_PAY_TO_EVM"]);
    expect(kinds(reviewService("api", good, inputs, { hyperliquid: ASTER, aster: ASTER }))).toEqual(["fail:HL_BUILDER_ADDRESS"]);
    expect(kinds(reviewService("api", good, inputs, { hyperliquid: null, aster: ASTER }))).toEqual(["fail:HL_BUILDER_ADDRESS"]);
    // a pinned builder with no env value fails; neither known is pending
    expect(kinds(reviewService("api", env(`${base}HL_BUILDER_ADDRESS=@HL_BUILDER@\n`), {}, pins))).toEqual(["fail:HL_BUILDER_ADDRESS"]);
    expect(kinds(reviewService("api", env(`${base}HL_BUILDER_ADDRESS=@HL_BUILDER@\n`), {}, { hyperliquid: null, aster: null }))).toEqual(["pending:HL_BUILDER_ADDRESS"]);
    // no empty security setting (DEP-6), mainnet chain ids only, no testnet RPC, dev signer only on 31337
    expect(kinds(reviewService("anchor", env(`${base}ANCHOR_KEYSTORE_PASSWORD_FILE=\n`), {}, pins))).toEqual(["fail:ANCHOR_KEYSTORE_PASSWORD_FILE"]);
    expect(kinds(reviewService("anchor", env(`${base}ANCHOR_SIGNER=keystore\nANCHOR_CHAIN_ID=46630\n`), {}, pins))).toEqual(["fail:ANCHOR_CHAIN_ID"]);
    expect(kinds(reviewService("workers", env(`${base}ANCHOR_SIGNER=dev\nANCHOR_CHAIN_ID=31337\n`), {}, pins))).toEqual([]);
    expect(kinds(reviewService("workers", env(`${base}ANCHOR_SIGNER=dev\nANCHOR_CHAIN_ID=4663\n`), {}, pins))).toEqual(["fail:ANCHOR_SIGNER"]);
    expect(kinds(reviewService("api", env(`CAPSTAN_NETWORK=mainnet\nRHC_RPC_URL=https://rpc.testnet.chain.robinhood.com\n`), {}, pins))).toEqual(["fail:RHC_RPC_URL"]);
    expect(kinds(reviewService("api", env(`CAPSTAN_NETWORK=testnet\n`), {}, pins))).toEqual(["fail:CAPSTAN_NETWORK"]);
  });

  test("a missing overlay or a flag switched on in an overlay fails the whole review", () => {
    const d = mkdtempSync(join(tmpdir(), "env-review-"));
    cpSync(join(ROOT, "ops/mainnet/env"), join(d, "overlays"), { recursive: true });
    writeFileSync(join(d, "overlays/relay.env"), "CAPSTAN_NETWORK=mainnet\nLIGHTER_MAKER_ONLY=1\n");
    let r = review({ overlays: join(d, "overlays") });
    expect(r.findings.filter((f) => f.kind === "fail").map((f) => `${f.svc}:${f.key}`)).toEqual(["relay:LIGHTER_MAKER_ONLY"]);
    mkdirSync(join(d, "empty"));
    r = review({ overlays: join(d, "empty") });
    expect(r.findings.filter((f) => f.key === "-").length).toBe(8);
  });
});
