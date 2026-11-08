// Test helpers: a throwaway testnet home in a temp folder, stand-in tools, and stub fetches. Nothing here touches the
// real ~/.capstan-testnet or ~/.foundry/keystores.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorReport, NeedResult } from "../doctor";
import { WALLETS } from "../wallets";

export function tempHome(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "capstan-testnet-test-"));
  return { dir, env: { CAPSTAN_TESTNET_HOME: join(dir, "home"), CAPSTAN_TESTNET_KEYSTORES: join(dir, "ks"), CAPSTAN_TESTNET_SCRYPT_N: "1024" } };
}

/** A stand-in `cast` that answers `chain-id` with the given id and logs every call to calls.log. */
export function stubCast(dir: string, chainId: number): string {
  const tools = join(dir, "tools");
  Bun.spawnSync(["mkdir", "-p", tools]);
  const f = join(tools, "cast");
  writeFileSync(f, `#!/bin/bash\necho "$*" >> "${join(tools, "calls.log")}"\nif [ "$1" = "chain-id" ]; then echo ${chainId}; exit 0; fi\necho "unexpected cast $1" >&2; exit 3\n`);
  chmodSync(f, 0o755);
  return tools;
}

export function jsonRpcFetch(answers: Record<string, unknown>): (url: string, init?: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
    if (!(body.method in answers)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `no stub for ${body.method}` } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[body.method] }));
  };
}

/** A doctor report where the given roles are funded and every other need is missing. */
export function fakeDoctor(fundedRoles: string[], addresses: Record<string, string> = {}): DoctorReport {
  const rows: NeedResult[] = [];
  const funded: Record<string, boolean> = {};
  for (const w of WALLETS) {
    const address = addresses[w.role] ?? `0x${(WALLETS.indexOf(w) + 1).toString(16).padStart(40, "0")}`;
    addresses[w.role] = address;
    const ok = fundedRoles.includes(w.role) || !w.needs.length;
    funded[w.role] = ok;
    for (const n of w.needs) rows.push({ role: w.role, address, network: n.network, asset: n.asset, balance: ok ? n.min : 0, min: n.min, ok, missing: ok ? null : `needs ${n.min} ${n.asset}`, backlog: n.backlog, faucet: n.faucet, ...(n.network.startsWith("lighter") && ok ? { detail: { accountIndex: 7 } } : {}) });
  }
  return { at: new Date().toISOString(), rows, funded, addresses };
}
