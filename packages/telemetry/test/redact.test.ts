import { logger } from "@capstan/core";
import { describe, expect, test } from "bun:test";
import { b64sha256, redact, REDACTED, stripIps } from "../src";

const SIG65 = "0x" + "1b".repeat(65); // a 65-byte signature shape, built at run time
const HASH64 = "0x" + "c3".repeat(32);
const HEX64 = /[0-9a-fA-F]{64}/;

describe("redact", () => {
  test("signatures: no 65-byte signature hex or 64-hex string survives; signature fields become hashes", () => {
    const rec = {
      msg: `submit ${HASH64} done`,
      signature: SIG65,
      ownerSig: SIG65,
      ackSig: SIG65,
      signedPayload: { action: { type: "order" }, signature: { r: "0x" + "aa".repeat(32), s: "0x" + "bb".repeat(32), v: 27 } },
      nested: { sig: SIG65, list: [SIG65, { txHash: HASH64 }] },
      password: "hunter2",
      apiKey: "ck_live_x",
    };
    const out = redact(rec);
    const line = JSON.stringify(out);
    expect(line).not.toMatch(HEX64);
    expect(line).not.toContain("1b1b1b1b");
    expect(out.signature_sha256).toBe(b64sha256(SIG65));
    expect(out.ownerSig_sha256).toBe(b64sha256(SIG65));
    expect(out.signature).toBeUndefined();
    expect(out.password).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(String(out.msg)).toStartWith("submit hex_sha256:");

    // through the service logger too: the written line carries no long hex
    const lines: string[] = [];
    logger("relay", { sink: (l) => lines.push(l) }).info("submitted", redact({ signature: SIG65, payloadHash: HASH64 }));
    expect(lines[0]).not.toMatch(HEX64);
    expect(JSON.parse(lines[0]!).signature_sha256).toBe(b64sha256(SIG65));
  });

  test("short hex (addresses, 32-hex trace ids) is kept", () => {
    const out = redact({ owner: "0x" + "ab".repeat(20), trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" });
    expect(out.owner).toBe("0x" + "ab".repeat(20));
    expect(out.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  test("stripIps keeps the country and removes IP fields and literals", () => {
    const out = stripIps({ ip: "203.0.113.9", msg: "from 2001:db8::5 via 198.51.100.1", headers: { "X-Forwarded-For": "203.0.113.9" } }, () => "DE");
    expect(JSON.stringify(out)).not.toMatch(/203\.0|198\.51|2001:db8/);
    expect(out.ip_country).toBe("DE");
  });
});
