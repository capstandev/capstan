// R8 (todo 14): Mode A field types follow the JS value and the sent query carries the same JS types.
import { describe, expect, test } from "bun:test";
import { AsterSignError, fieldType, mgmtSentQuery, mgmtTypedData, mgmtTypeString, parseQuery, queryString, tradeTypedData, type Param } from "../src";

describe("aster typed data", () => {
  test("type-inference", () => {
    expect(fieldType(true)).toBe("bool");
    expect(fieldType(false)).toBe("bool");
    expect(fieldType(1796513875000)).toBe("uint256");
    expect(fieldType(1793921875000002n)).toBe("uint256");
    expect(fieldType("0.0003")).toBe("string");
    expect(fieldType("0x255b19e79F60e1Ed20076Fe195BF5045f3E016C1")).toBe("string");
    expect(fieldType("1796513875000")).toBe("string"); // a numeric string stays a string: the JS type decides
    expect(() => fieldType(0.5)).toThrow(AsterSignError);
    expect(() => fieldType(-1)).toThrow(AsterSignError);
    const p: Param[] = [
      ["agentName", "capstan"],
      ["agentAddress", "0x255b19e79F60e1Ed20076Fe195BF5045f3E016C1"],
      ["ipWhitelist", "203.0.113.7"],
      ["expired", 1796513875000],
      ["canSpotTrade", false],
      ["canPerpTrade", true],
      ["canWithdraw", false],
      ["asterChain", "Testnet"],
      ["user", "0x77c87137A21b2C13B620415Bbb58ACe24b16755B"],
      ["nonce", 1793921875000002n],
    ];
    const td = mgmtTypedData("ApproveAgent", p);
    expect(td.domain).toEqual({ name: "AsterSignTransaction", version: "1", chainId: 56, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(td.types.ApproveAgent!.map((f) => f.type)).toEqual(["string", "string", "string", "uint256", "bool", "bool", "bool", "string", "string", "uint256"]);
    expect(td.types.ApproveAgent!.map((f) => f.name)).toEqual(["AgentName", "AgentAddress", "IpWhitelist", "Expired", "CanSpotTrade", "CanPerpTrade", "CanWithdraw", "AsterChain", "User", "Nonce"]);
    expect(mgmtTypeString(td)).toContain("uint256 Expired");
    // the sent query uses the same JS types: integer expired, true/false flags, string fees
    const sent = parseQuery(mgmtSentQuery(p, "0xabc"));
    expect(sent).toContainEqual(["expired", "1796513875000"]);
    expect(sent).toContainEqual(["canSpotTrade", "false"]);
    expect(sent).toContainEqual(["canPerpTrade", "true"]);
    expect(sent.at(-1)).toEqual(["signatureChainId", "56"]);
    expect(sent.at(-2)).toEqual(["signature", "0xabc"]);
    // Mode B is a single string field on the trading chain id
    expect(tradeTypedData("a=1", 714)).toEqual({ domain: { name: "AsterSignTransaction", version: "1", chainId: 714, verifyingContract: "0x0000000000000000000000000000000000000000" }, types: { Message: [{ name: "msg", type: "string" }] }, primaryType: "Message", message: { msg: "a=1" } });
    expect(() => tradeTypedData("a=1", 56 as never)).toThrow(AsterSignError);
    // query rules: insertion order, no sorting, no encoding, unique keys
    expect(queryString([["b", "2"], ["a", "1"]])).toBe("b=2&a=1");
    expect(queryString([["ip", "1.2.3.4"], ["x", ""]])).toBe("ip=1.2.3.4&x=");
    expect(() => queryString([["a", "1"], ["a", "2"]])).toThrow(AsterSignError);
    expect(() => queryString([["a", "x&b=2"]])).toThrow(AsterSignError);
    expect(() => queryString([["a b", "1"]])).toThrow(AsterSignError);
    expect(() => mgmtTypedData("Transfer" as never, p)).toThrow(AsterSignError);
  });
});
