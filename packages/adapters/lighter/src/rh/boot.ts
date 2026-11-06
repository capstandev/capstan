// Boot and nightly check of the Lighter-RH deposit contract. Deposit builds are refused (fail closed) unless GET /info
// names the pinned contract AND its EIP-1967 implementation slot holds the pinned implementation.
import { CHAINS, type Hex } from "@capstan/schema";
import { createPublicClient, http } from "viem";
import type { LighterReader } from "../read";
import { EIP1967_IMPLEMENTATION_SLOT, LIGHTER_RH_DEPOSIT } from "./constants";

/** The one RPC read this needs (a viem PublicClient fits). */
export interface SlotReader {
  getStorageAt(a: { address: Hex; slot: Hex }): Promise<Hex | undefined>;
  getChainId?(): Promise<number>;
}

export interface BootResult {
  ok: boolean;
  reason?: string;
  contract?: Hex;
  implementation?: Hex;
}

const lower = (s: string) => s.toLowerCase();

export async function bootCheck(reader: Pick<LighterReader, "info" | "cfg">, rpc: SlotReader): Promise<BootResult> {
  if (reader.cfg.venue !== "lighter-rh") return { ok: false, reason: `deposit builds are for lighter-rh, not ${reader.cfg.venue}` };
  try {
    if (rpc.getChainId) {
      const id = await rpc.getChainId();
      if (id !== LIGHTER_RH_DEPOSIT.chainId) return { ok: false, reason: `RPC chain id ${id} is not ${LIGHTER_RH_DEPOSIT.chainId}` };
    }
    const info = await reader.info();
    if (lower(info.contract) !== lower(LIGHTER_RH_DEPOSIT.address)) return { ok: false, reason: `GET /info names ${info.contract}, not the pinned ${LIGHTER_RH_DEPOSIT.address}`, contract: info.contract };
    const raw = await rpc.getStorageAt({ address: LIGHTER_RH_DEPOSIT.address, slot: EIP1967_IMPLEMENTATION_SLOT });
    if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return { ok: false, reason: "implementation slot unreadable", contract: info.contract };
    const impl = `0x${raw.slice(-40)}` as Hex;
    if (lower(impl) !== lower(LIGHTER_RH_DEPOSIT.implementationAtPin)) return { ok: false, reason: `implementation is ${impl}, not the pinned ${LIGHTER_RH_DEPOSIT.implementationAtPin}`, contract: info.contract, implementation: impl };
    return { ok: true, contract: info.contract, implementation: impl };
  } catch (e) {
    return { ok: false, reason: `check failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

/** A read-only Robinhood Chain client for the slot check (public RPC unless RHC_RPC_URL is set). */
export function rhcSlotReader(rpcUrl: string = process.env.RHC_RPC_URL ?? CHAINS.rhc.publicRpc): SlotReader {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }) });
  return { getStorageAt: (a) => client.getStorageAt(a), getChainId: () => client.getChainId() };
}
