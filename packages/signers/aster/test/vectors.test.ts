// The four Aster V3 vectors (todo 14 R1 to R4): query string, digest and signature reproduced byte for byte.
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { recoverDigestSigner, accountSigner, digestMgmt, digestTrade, mgmtSentQuery, mgmtTypedData, mgmtTypeString, queryString, recoverSigner, signMgmt, signTrade, type Param } from "../src";
import { testAccount } from "./keys";
import { ADDR, NONCE_BASE, TV1, TV2, TV3, TV4 } from "./vectors/aster";

const main = testAccount("main");
const signer = testAccount("signer");
const builder = testAccount("builder");

const order = (chain: "Mainnet" | "Testnet"): Param[] => [
  ["symbol", "BTCUSDT"],
  ["type", "LIMIT"],
  ["side", "BUY"],
  ["timeInForce", "GTC"],
  ["quantity", "0.001"],
  ["price", "70000"],
  ["builder", ADDR.builder],
  ["feeRate", "0.0002"],
  ["asterChain", chain],
  ["user", ADDR.user],
  ["signer", ADDR.signer],
  ["nonce", NONCE_BASE],
];

describe("aster vectors", () => {
  test("derived addresses", () => {
    expect(main.address).toBe(getAddress(ADDR.user));
    expect(signer.address).toBe(getAddress(ADDR.signer));
    expect(builder.address).toBe(getAddress(ADDR.builder));
  });

  test("tv1", async () => {
    const qs = queryString(order("Mainnet"));
    expect(qs).toBe(TV1.msg);
    expect(digestTrade(qs, 1666)).toBe(TV1.digest);
    const s = await signTrade(order("Mainnet"), 1666, accountSigner(signer));
    expect(s.signature).toBe(TV1.signature);
    expect(s.sent).toBe(`${TV1.msg}&signature=${TV1.signature}`);
    // a second implementation: viem's own typed-data signer over the same payload
    const viaViem = await signer.signTypedData({ domain: { name: "AsterSignTransaction", version: "1", chainId: 1666, verifyingContract: "0x0000000000000000000000000000000000000000" }, types: { Message: [{ name: "msg", type: "string" }] }, primaryType: "Message", message: { msg: qs } });
    expect(viaViem).toBe(TV1.signature);
    expect(await recoverSigner(TV1.digest, TV1.signature)).toBe(getAddress(ADDR.signer));
    expect(recoverDigestSigner(TV1.digest, TV1.signature)).toBe(getAddress(ADDR.signer));
    expect(recoverDigestSigner(TV4.digest, TV4.signature)).toBe(getAddress(ADDR.signer));
    expect(recoverDigestSigner(TV2.digest, TV2.signature)).toBe(getAddress(ADDR.user));
    expect(recoverDigestSigner(TV1.digest, "0x00")).toBeNull();
  });

  test("tv2", async () => {
    const p: Param[] = [
      ["builder", ADDR.builder],
      ["maxFeeRate", "0.0003"],
      ["builderName", "capstan"],
      ["asterChain", "Mainnet"],
      ["user", ADDR.user],
      ["nonce", NONCE_BASE + 1],
    ];
    expect(mgmtTypeString(mgmtTypedData("ApproveBuilder", p))).toBe(TV2.typeString);
    expect(digestMgmt("ApproveBuilder", p)).toBe(TV2.digest);
    const s = await signMgmt("ApproveBuilder", p, accountSigner(main));
    expect(s.signature).toBe(TV2.signature);
    expect(s.sent).toBe(`builder=${ADDR.builder}&maxFeeRate=0.0003&builderName=capstan&asterChain=Mainnet&user=${ADDR.user}&nonce=${NONCE_BASE + 1}&signature=${TV2.signature}&signatureChainId=56`);
    expect(mgmtSentQuery(p, TV2.signature)).toBe(s.sent);
    const td = mgmtTypedData("ApproveBuilder", p);
    const viaViem = await (main.signTypedData as (a: unknown) => Promise<string>)({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message });
    expect(viaViem).toBe(TV2.signature);
  });

  test("tv3", async () => {
    const p: Param[] = [
      ["agentName", "capstan"],
      ["agentAddress", ADDR.signer],
      ["ipWhitelist", ""],
      ["expired", TV3.expired],
      ["canSpotTrade", false],
      ["canPerpTrade", true],
      ["canWithdraw", false],
      ["asterChain", "Mainnet"],
      ["user", ADDR.user],
      ["nonce", NONCE_BASE + 2],
    ];
    expect(mgmtTypeString(mgmtTypedData("ApproveAgent", p))).toBe(TV3.typeString);
    expect(TV3.expired as number).toBe(Math.floor(NONCE_BASE / 1000) + 30 * 86_400_000);
    expect(digestMgmt("ApproveAgent", p)).toBe(TV3.digest);
    expect((await signMgmt("ApproveAgent", p, accountSigner(main))).signature).toBe(TV3.signature);
    expect(await recoverSigner(TV3.digest, TV3.signature)).toBe(getAddress(ADDR.user));
  });

  test("tv4", async () => {
    const qs = queryString(order("Testnet"));
    expect(qs).toBe(TV1.msg.replace("asterChain=Mainnet", "asterChain=Testnet"));
    expect(digestTrade(qs, 714)).toBe(TV4.digest);
    expect((await signTrade(order("Testnet"), 714, accountSigner(signer))).signature).toBe(TV4.signature);
    // the chain id is part of the digest: the mainnet digest differs
    expect(digestTrade(qs, 1666)).not.toBe(TV4.digest);
  });
});
