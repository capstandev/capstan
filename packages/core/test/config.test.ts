// R7, R24 and the raw-key refusal.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configNames, loadConfig, ROLES, type Role } from "../src/config";

function envExample(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(import.meta.dir, "../../../.env.example"), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe("config", () => {
  test("missing-names", () => {
    let err: unknown;
    try {
      loadConfig("relay", {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.names).toEqual(["DATABASE_URL", "RECEIPT_KEYSTORE_PASSWORD_FILE", "RECEIPT_KEYSTORE_PATH", "REDIS_URL"]);
    expect(ce.message).toBe("config(relay): missing or invalid: DATABASE_URL, RECEIPT_KEYSTORE_PASSWORD_FILE, RECEIPT_KEYSTORE_PATH, REDIS_URL");
    // the dev signer on the local chain needs no keystore
    expect(() => loadConfig("relay", { RECEIPT_SIGNER: "dev" })).toThrow("config(relay): missing or invalid: DATABASE_URL, REDIS_URL");
  });

  test("errors name variables, never values", () => {
    const secretLooking = "postgres-NOT-A-URL-value-9d1e";
    try {
      loadConfig("api", { DATABASE_URL: secretLooking, REDIS_URL: "redis://x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("DATABASE_URL");
      expect((e as Error).message).not.toContain(secretLooking);
    }
  });

  test("a role does not require another role's variables", () => {
    expect(loadConfig("mcp", {}).MCP_PORT).toBe(8713); // mcp needs no database, redis or signer
    expect(loadConfig("ws", { REDIS_URL: "redis://127.0.0.1:1" }).WS_PORT).toBe(8711);
    expect(configNames("ws")).not.toContain("DATABASE_URL");
    expect(configNames("api")).not.toContain("RECEIPT_SIGNER");
  });

  test("raw key variables are refused by name", () => {
    const env = { ...envExample(), ANCHOR_PRIVATE_KEY: "whatever" };
    expect(() => loadConfig("workers", env)).toThrow("config(workers): refused: ANCHOR_PRIVATE_KEY");
    expect(() => loadConfig("api", { ...envExample(), DEPLOYER_MNEMONIC: "x" })).toThrow(/refused: DEPLOYER_MNEMONIC/);
  });

  test("dev signer only on chain 31337; keystore needs both paths", () => {
    const env = envExample();
    expect(() => loadConfig("relay", { ...env, RECEIPT_CHAIN_ID: "46630" })).toThrow(/refused: RECEIPT_SIGNER, RECEIPT_CHAIN_ID/);
    expect(() => loadConfig("relay", { ...env, RECEIPT_SIGNER: "keystore" })).toThrow(/RECEIPT_KEYSTORE_PATH, RECEIPT_KEYSTORE_PASSWORD_FILE/);
    const ok = loadConfig("relay", { ...env, RECEIPT_SIGNER: "keystore", RECEIPT_CHAIN_ID: "46630", RECEIPT_KEYSTORE_PATH: "/k.json", RECEIPT_KEYSTORE_PASSWORD_FILE: "/p" });
    expect(ok.RECEIPT_SIGNER).toBe("keystore");
  });

  test("arming a mainnet broadcaster needs CAPSTAN_NETWORK=mainnet", () => {
    const env = { ...envExample(), ANCHOR_SIGNER: "keystore", ANCHOR_KEYSTORE_PATH: "/k", ANCHOR_KEYSTORE_PASSWORD_FILE: "/p", ANCHOR_CHAIN_ID: "4663", ANCHOR_ARMED: "1" };
    expect(() => loadConfig("workers", env)).toThrow(/refused: ANCHOR_ARMED, ANCHOR_CHAIN_ID, CAPSTAN_NETWORK/);
    expect(loadConfig("workers", { ...env, CAPSTAN_NETWORK: "mainnet", CAPSTAN_EGRESS_ID: "vps-1" }).ANCHOR_ARMED).toBe(true);
  });

  test("env-example-safe", () => {
    const env = envExample();
    for (const role of ROLES as Role[]) {
      // every variable a role reads is listed in .env.example (optional keystore paths excepted)
      for (const n of configNames(role)) if (!/_KEYSTORE_(PATH|PASSWORD_FILE)$/.test(n)) expect(Object.keys(env), `${role}: ${n}`).toContain(n);
      let cfg: Record<string, unknown>;
      try {
        cfg = loadConfig(role, env) as unknown as Record<string, unknown>;
      } catch (e) {
        // allowed outcome: refuse to start, naming what is missing
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).names.length).toBeGreaterThan(0);
        continue;
      }
      expect(cfg.CAPSTAN_NETWORK).toBe("local");
      for (const [k, v] of Object.entries(cfg)) {
        if (/_ARMED$|STAKER_BUCKET_ENABLED|EQ_EXECUTION_ALLOWED|X402_USDG_EIP3009_MAINNET/.test(k)) expect(v, `${role}: ${k}`).toBe(false);
        if (/_SIGNER$/.test(k) && v === "dev") expect(cfg[k.replace(/_SIGNER$/, "_CHAIN_ID")], `${role}: ${k}`).toBe(31337);
        if (/RATE_LIMIT|PER_MIN|FLOAT_MAX/.test(k)) expect(typeof v === "number" && v > 0, `${role}: ${k}`).toBe(true);
      }
    }
  });
});
