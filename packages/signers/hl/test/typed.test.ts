// R5, R7, R13 and the network-separation rule.
import { describe, expect, test } from "bun:test";
import { viemTypedDigest } from "./helpers";
import { DEFAULT_MAX_FEE_RATE, l1Digest, userSignedDigest, userSignedTypedData, USER_SIGNED_TYPES, type HlOrderAction, type HlUserAction } from "../src";

const NONCE = 1793900000000;
const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as const;
const users: HlUserAction[] = [
  { type: "approveAgent", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", agentAddress: mixed, agentName: "cpst-abcdef", nonce: NONCE },
  { type: "approveBuilderFee", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", maxFeeRate: "0.03%", builder: mixed, nonce: NONCE },
  { type: "sendAsset", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", destination: mixed, sourceDex: "", destinationDex: "xyz", token: "USDC", amount: "10", fromSubAccount: "", nonce: NONCE },
  { type: "userSetAbstraction", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", user: mixed, abstraction: "unifiedAccount", nonce: NONCE },
];

describe("typed", () => {
  test("no-signatureChainId-in-struct", () => {
    for (const spec of Object.values(USER_SIGNED_TYPES)) expect(spec.fields.map((f) => f.name)).not.toContain("signatureChainId");
    for (const a of users) {
      const td = userSignedTypedData(a);
      expect(td.types[td.primaryType]!.map((f) => f.name)).not.toContain("signatureChainId");
      expect("signatureChainId" in td.message).toBe(false);
      expect(td.domain.chainId).toBe(0xa4b1);
      // a different signatureChainId changes only the domain, so the digest changes
      expect(userSignedDigest({ ...a, signatureChainId: "0x66eee" } as HlUserAction)).not.toBe(userSignedDigest(a));
      // independent hasher agrees
      expect(viemTypedDigest(td as never)).toBe(userSignedDigest(a));
    }
  });

  test("lowercase-addresses", () => {
    for (const a of users) {
      const lower = JSON.parse(JSON.stringify(a).replaceAll(mixed, mixed.toLowerCase())) as HlUserAction;
      expect(userSignedDigest(a)).toBe(userSignedDigest(lower));
    }
    const order = (b: `0x${string}`, vault: `0x${string}` | null): [HlOrderAction, `0x${string}` | null] => [
      { type: "order", orders: [{ a: 0, b: true, p: "76000", s: "0.001", r: false, t: { limit: { tif: "Ioc" } }, c: "0x0000000000000000000000000000ABCD" }], grouping: "na", builder: { b, f: 20 } },
      vault,
    ];
    const [m, mv] = order(mixed, mixed);
    const [l, lv] = order(mixed.toLowerCase() as `0x${string}`, mixed.toLowerCase() as `0x${string}`);
    l.orders[0]!.c = "0x0000000000000000000000000000abcd";
    expect(l1Digest(m, mv, NONCE, "Mainnet")).toBe(l1Digest(l, lv, NONCE, "Mainnet"));
  });

  test("max-fee-rate-format", () => {
    const base = users[1] as Extract<HlUserAction, { type: "approveBuilderFee" }>;
    expect(DEFAULT_MAX_FEE_RATE).toBe("0.03%");
    for (const ok of ["0.03%", "0.1%", "0%", "0.001%", "0.10%"]) expect(() => userSignedDigest({ ...base, maxFeeRate: ok as `${string}%` })).not.toThrow();
    for (const bad of ["0.11%", "1%", "0.03", ".03%", "0.03 %", "-0.01%", "3bps%", "0.1000001%"]) expect(() => userSignedDigest({ ...base, maxFeeRate: bad as `${string}%` })).toThrow();
  });

  test("network-separation", () => {
    const action: HlOrderAction = { type: "order", orders: [{ a: 0, b: true, p: "76000", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na", builder: { b: mixed, f: 20 } };
    expect(l1Digest(action, null, NONCE, "Mainnet")).not.toBe(l1Digest(action, null, NONCE, "Testnet"));
    for (const a of users) expect(userSignedDigest(a)).not.toBe(userSignedDigest({ ...a, hyperliquidChain: "Testnet" } as HlUserAction));
  });
});
