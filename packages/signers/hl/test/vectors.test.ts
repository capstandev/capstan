// R1 to R4: every committed vector replays byte for byte (msgpack, connectionId, digest, signature).
import { describe, expect, test } from "bun:test";
import * as signer from "../src";
import { actionHash, actionMsgpack, fromHex, l1Digest, recoverSigner, signDigest, USER_SIGNED_TYPES, userSignedDigest, type HlL1Action, type HlUserAction } from "../src";
import { HL_VECTORS, SDK_PUBLIC_SIGNING_FIXTURE } from "./vectors/hl";
import { viemTypedDigest } from "./helpers";

type L1Vec = (typeof HL_VECTORS.l1)[number];
const key = fromHex(SDK_PUBLIC_SIGNING_FIXTURE);
const SIGNER = HL_VECTORS.signer.toLowerCase();

function firstDiff(a: string, b: string): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return Math.floor(i / 2);
  return -1;
}

function replayL1(v: L1Vec): void {
  const action = v.action as unknown as HlL1Action;
  const network = v.isMainnet ? "Mainnet" : "Testnet";
  const vault = (v.vaultAddress ?? null) as `0x${string}` | null;
  const exp = v.expiresAfter ?? undefined;
  const packed = Buffer.from(actionMsgpack(action)).toString("hex");
  if (packed !== v.msgpackHex) throw new Error(`${v.name}: msgpack differs at byte ${firstDiff(packed, v.msgpackHex)}`);
  expect(actionHash(action, vault, v.nonce, exp)).toBe(v.connectionId as `0x${string}`);
  const digest = l1Digest(action, vault, v.nonce, network, exp);
  expect(digest).toBe(v.eip712Digest as `0x${string}`);
  const sig = signDigest(digest, key);
  expect(sig).toEqual({ r: v.signature.r, s: v.signature.s, v: v.signature.v } as never);
  expect(recoverSigner(digest, v.signature as never).toLowerCase()).toBe(SIGNER);
}

describe("vectors", () => {
  test("sdk-l1", () => {
    const sdk = HL_VECTORS.l1.filter((v) => v.fromSdkTests);
    expect(sdk.length).toBe(12);
    for (const v of sdk) replayL1(v);
  });

  test("capstan-l1", () => {
    const cpst = HL_VECTORS.l1.filter((v) => !v.fromSdkTests);
    expect(cpst.length).toBe(7);
    const names = cpst.map((v) => v.name);
    for (const n of ["cpst_core_btc_builder20_mainnet", "cpst_core_btc_builder20_testnet", "cpst_core_btc_builder10_expiresAfter_mainnet", "cpst_hip3_xyz_TSLA_asset110001_builder20_mainnet", "cpst_hip3_io_asset200000_nobuilder_mainnet", "cpst_two_orders_cloid_vault_mainnet", "cpst_cancel_mainnet"]) expect(names).toContain(n);
    for (const v of cpst) replayL1(v);
  });

  test("user-signed", () => {
    expect(HL_VECTORS.userSigned.length).toBe(8);
    let viaPackage = 0;
    let viaGeneric = 0;
    for (const v of HL_VECTORS.userSigned) {
      const m = v.message as Record<string, unknown>;
      if (v.fromSdkTests) {
        // usdSend and withdraw: replayed through an independent typed-data hasher; the package has no builder for them.
        const types = { [v.primaryType]: v.types as { name: string; type: string }[] };
        const digest = viemTypedDigest({ domain: v.domain as never, types, primaryType: v.primaryType, message: m });
        expect(digest).toBe(v.eip712Digest as `0x${string}`);
        expect(recoverSigner(digest, v.signature as never).toLowerCase()).toBe(SIGNER);
        viaGeneric++;
        continue;
      }
      const action = { ...m } as unknown as HlUserAction;
      const spec = USER_SIGNED_TYPES[action.type];
      expect(spec.primaryType).toBe(v.primaryType);
      expect(spec.fields).toEqual(v.types as never);
      const digest = userSignedDigest(action);
      expect(digest).toBe(v.eip712Digest as `0x${string}`);
      expect(recoverSigner(digest, v.signature as never).toLowerCase()).toBe(SIGNER);
      expect(signDigest(digest, key)).toEqual(v.signature as never);
      expect(viemTypedDigest(signer.userSignedTypedData(action) as never)).toBe(digest);
      viaPackage++;
    }
    expect(viaGeneric).toBe(2);
    expect(viaPackage).toBe(6);
    // No withdraw, usdSend or third-party transfer builder is exported.
    expect(Object.keys(USER_SIGNED_TYPES).sort()).toEqual(["approveAgent", "approveBuilderFee", "sendAsset", "userSetAbstraction"]);
    for (const name of Object.keys(signer)) expect(/withdraw|usdsend|usdtransfer|spotsend/i.test(name)).toBe(false);
  });

  test("phantom-production", () => {
    const p = HL_VECTORS.phantomAgentProductionCheck;
    const action: HlL1Action = { type: "order", orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
    expect(actionHash(action, null, p.nonce)).toBe(p.connectionId as `0x${string}`);
  });
});
