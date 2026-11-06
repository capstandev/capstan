// The token-address box reads contracts.json and nothing else (one source). ops/ci/gen-deployments.ts writes
// web/public/contracts.json from contracts/deployments/<chainId>.json; `cpst` stays empty until CPST is deployed.
import generated from "../../public/contracts.json";

export interface CpstEntry {
  address: string;
  symbol: string;
  decimals: number;
  supply: string;
  lock?: string;
  anchor?: string;
}

export interface ContractsJson {
  generatedBy: string;
  cpst: Record<string, CpstEntry>;
}

export const CONTRACTS: ContractsJson = generated as ContractsJson;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The CPST entry for a chain, or null while nothing valid is deployed there. */
export function cpstOn(chainId: number, data: ContractsJson = CONTRACTS): CpstEntry | null {
  const e = data.cpst?.[String(chainId)];
  return e && typeof e.address === "string" && ADDRESS.test(e.address) ? e : null;
}
