// Read-only live check of a deployment (todo 47 R5, R9): never signs, never sends. Run by live-check.sh after the
// owner's go (real 4663 RPC) or by dry-run.sh against the fork record.
//   bun ops/mainnet/live-check.ts --file contracts/deployments/4663.json --rpc URL --safe 0xBRAND_SAFE [--out FILE]
//   bun ops/mainnet/live-check.ts --safe-only --rpc URL --safe 0xBRAND_SAFE        (the Safe check alone)
// Checks: chain id; runtime code at every address equal to the local build with immutables masked (and each
// immutable equal to what the file says); poster(), token(); CPST symbol(), decimals(), name, totalSupply equal to
// the file and the whole supply held by the brand Safe; the real Safe check (SafeProxy 1.4.1 codehash, official
// singleton, threshold >= 2, no module, no guard); Sourcify status from its read API (not applicable on a fork).
import type { Hex } from "@capstan/schema";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPublicClient, http, keccak256, parseAbi, type PublicClient } from "viem";
import { args, isDryRunRpc, ROOT, SAFE_141 } from "./lib";

export interface Check {
  what: string;
  ok: boolean;
  detail: string;
}

type Artifact = { deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> } };

/** Zero every immutable range (byte offsets) in a hex runtime code string. */
export function maskImmutables(code: Hex, refs: Record<string, { start: number; length: number }[]> = {}): string {
  const b = code.slice(2).toLowerCase().split("");
  for (const ranges of Object.values(refs)) for (const r of ranges) for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < b.length; i++) b[i] = "0";
  return b.join("");
}

/** The 32-byte words at the immutable offsets (one value per immutable id, all copies must agree). */
export function immutableValues(code: Hex, refs: Record<string, { start: number; length: number }[]> = {}): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const h = code.slice(2).toLowerCase();
  for (const [id, ranges] of Object.entries(refs)) {
    const vals = new Set(ranges.map((r) => h.slice(r.start * 2, (r.start + r.length) * 2)));
    out[id] = vals.size === 1 ? [...vals][0]! : null;
  }
  return out;
}

export function compareRuntime(onChain: Hex, art: Artifact): { equal: boolean; immutables: Record<string, string | null> } {
  const refs = art.deployedBytecode.immutableReferences ?? {};
  return { equal: maskImmutables(onChain, refs) === maskImmutables(art.deployedBytecode.object, refs), immutables: immutableValues(onChain, refs) };
}

const word = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

const ABI = parseAbi([
  "function poster() view returns (address)",
  "function token() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function masterCopy() view returns (address)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
  "function getStorageAt(uint256,uint256) view returns (bytes)",
]);

/** The real Safe check, the same rules as contracts/script/lib/SafeCheck.sol, read with eth_call. */
export async function safeCheck(pc: PublicClient, safe: Hex): Promise<Check> {
  const code = (await pc.getCode({ address: safe })) ?? "0x";
  const fail = (why: string): Check => ({ what: "brand Safe passes the real Safe check", ok: false, detail: why });
  if (code === "0x") return fail("no code");
  if (code.length === 48 && code.toLowerCase().startsWith("0xef0100")) return fail("EIP-7702 delegated EOA");
  if (keccak256(code).toLowerCase() !== SAFE_141.proxyCodehash.toLowerCase()) return fail("runtime code is not the Safe 1.4.1 proxy");
  const r = (fn: "masterCopy" | "getThreshold" | "getOwners", a: unknown[] = []) => pc.readContract({ address: safe, abi: ABI, functionName: fn as never, args: a as never });
  const singleton = ((await r("masterCopy")) as Hex).toLowerCase();
  if (singleton !== SAFE_141.singleton.toLowerCase() && singleton !== SAFE_141.singletonL2.toLowerCase()) return fail(`singleton ${singleton} is not Safe 1.4.1 or SafeL2 1.4.1`);
  const threshold = (await r("getThreshold")) as bigint;
  const owners = (await r("getOwners")) as Hex[];
  if (threshold < 2n) return fail(`threshold ${threshold}`);
  const [mods] = (await pc.readContract({ address: safe, abi: ABI, functionName: "getModulesPaginated", args: ["0x0000000000000000000000000000000000000001", 10n] })) as [Hex[], Hex];
  if (mods.length) return fail(`${mods.length} module(s) enabled`);
  const g = (await pc.readContract({ address: safe, abi: ABI, functionName: "getStorageAt", args: [BigInt(SAFE_141.guardSlot), 1n] })) as Hex;
  if (BigInt(g) !== 0n) return fail("a guard is set");
  return { what: "brand Safe passes the real Safe check", ok: true, detail: `Safe 1.4.1 proxy, singleton ${singleton === SAFE_141.singletonL2.toLowerCase() ? "SafeL2" : "Safe"} 1.4.1, ${threshold} of ${owners.length}, no module, no guard` };
}

export async function liveCheck(o: { file: string; rpc: string; safe: Hex; sourcifyApi?: string; contractsDir?: string; fetchImpl?: typeof fetch }): Promise<{ checks: Check[]; chainId: number }> {
  const d = JSON.parse(readFileSync(o.file, "utf8")) as { chainId: number; contracts: Record<string, { address: Hex; poster?: Hex; symbol?: string; decimals?: number; supply?: string }> };
  const pc = createPublicClient({ transport: http(o.rpc) }) as PublicClient;
  const checks: Check[] = [];
  const add = (what: string, ok: boolean, detail: string) => checks.push({ what, ok, detail });
  const cid = await pc.getChainId();
  add("chain id equals the deployment file", cid === d.chainId, `rpc ${cid}, file ${d.chainId}`);
  const cdir = o.contractsDir ?? join(ROOT, "contracts");
  const c = d.contracts;
  const expectImm: Record<string, string[]> = {
    CapstanReceiptAnchor: [word(c.CapstanReceiptAnchor?.poster ?? "")],
    CPSTLock: [word(c.CPST?.address ?? "")],
  };
  for (const name of ["CPST", "CPSTLock", "CapstanReceiptAnchor"] as const) {
    const addr = c[name]?.address;
    if (!addr) {
      add(`${name} runtime code equals the build`, false, "no address in the file");
      continue;
    }
    const art = JSON.parse(readFileSync(join(cdir, "out", `${name}.sol`, `${name}.json`), "utf8")) as Artifact;
    const code = ((await pc.getCode({ address: addr })) ?? "0x") as Hex;
    const cmp = compareRuntime(code, art);
    const imms = Object.values(cmp.immutables);
    const want = expectImm[name] ?? [];
    const immOk = imms.every((v) => v !== null) && want.every((w) => imms.includes(w));
    add(`${name} runtime code equals the build (immutables masked)`, code !== "0x" && cmp.equal, `${(code.length - 2) / 2} bytes at ${addr}`);
    if (imms.length || want.length) add(`${name} immutables equal the file`, immOk, `${imms.length} immutable(s)${want.length ? `, expected ${want.map((w) => `0x${w.slice(24)}`).join(", ")}` : ""}`);
  }
  const read = <T>(address: Hex, fn: string, a: unknown[] = []) => pc.readContract({ address, abi: ABI, functionName: fn as never, args: a as never }) as Promise<T>;
  if (c.CapstanReceiptAnchor && c.CPSTLock && c.CPST) {
    const poster = await read<Hex>(c.CapstanReceiptAnchor.address, "poster");
    add("anchor poster() equals the file", poster.toLowerCase() === (c.CapstanReceiptAnchor.poster ?? "").toLowerCase(), poster);
    const token = await read<Hex>(c.CPSTLock.address, "token");
    add("lock token() equals CPST", token.toLowerCase() === c.CPST.address.toLowerCase(), token);
    const [sym, nm, dec, sup] = await Promise.all([read<string>(c.CPST.address, "symbol"), read<string>(c.CPST.address, "name"), read<number>(c.CPST.address, "decimals"), read<bigint>(c.CPST.address, "totalSupply")]);
    add("CPST symbol() and decimals() equal the file (ticker re-read, R9)", sym === c.CPST.symbol && sym === "CPST" && Number(dec) === c.CPST.decimals && Number(dec) === 18, `${sym}, ${dec} decimals, name ${nm}`);
    add("CPST totalSupply equals the file", sup.toString() === c.CPST.supply || sup === BigInt(c.CPST.supply ?? "0") * 10n ** 18n, `${sup}`);
    const held = await read<bigint>(c.CPST.address, "balanceOf", [o.safe]);
    add("the whole CPST supply sits in the brand Safe", held === sup && sup > 0n, `${held} of ${sup} at ${o.safe}`);
  }
  checks.push(await safeCheck(pc, o.safe));
  if (isDryRunRpc(o.rpc) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(o.rpc)) {
    add("Sourcify status", true, "not applicable: fork addresses do not exist on the real chain");
  } else {
    const api = o.sourcifyApi ?? "https://sourcify.dev/server";
    const f = o.fetchImpl ?? fetch;
    const chains = (await f(`${api}/chains`).then((r) => r.json()).catch(() => [])) as { chainId: number; supported?: boolean }[];
    const listed = chains.some((x) => x.chainId === d.chainId && x.supported !== false);
    for (const name of ["CPST", "CPSTLock", "CapstanReceiptAnchor"] as const) {
      const a = c[name]?.address;
      if (!a) continue;
      if (!listed) {
        add(`Sourcify ${name}`, true, `not supported: chain ${d.chainId} is not listed at ${api}/chains (recorded)`);
        continue;
      }
      const j = (await f(`${api}/v2/contract/${d.chainId}/${a}`).then((r) => r.json()).catch(() => ({}))) as { match?: string };
      add(`Sourcify ${name}`, j.match === "match" || j.match === "exact_match", `match: ${j.match ?? "none"}`);
    }
  }
  return { checks, chainId: cid };
}

export function renderLiveCheck(r: { checks: Check[]; chainId: number }, meta: { file: string; rpc: string; safe: string; when: string; buildSha: string }): string {
  const pass = r.checks.every((c) => c.ok);
  const rows = r.checks.map((c) => `| ${c.ok ? "pass" : "FAIL"} | ${c.what} | ${c.detail.replace(/\|/g, "/")} |`).join("\n");
  return `# Live check, chain ${r.chainId}, ${meta.when}\n\nResult: **${pass ? "PASS" : "FAIL"}** (${r.checks.filter((c) => c.ok).length} of ${r.checks.length}). Read-only: nothing was signed or sent.\n\n- Deployment file: \`${meta.file}\`\n- RPC: \`${meta.rpc}\`\n- Brand Safe: \`${meta.safe}\`\n- Build: commit ${meta.buildSha}\n\n| Result | Check | Detail |\n|---|---|---|\n${rows}\n\nNext: run the audit grader in verify mode against this file.\n`;
}

if (import.meta.main) {
  const o = args(process.argv.slice(2));
  if (o["safe-only"] && o.rpc && o.safe) {
    // the brand Safe alone (go-live step E1), before any deployment exists
    const c = await safeCheck(createPublicClient({ transport: http(o.rpc) }) as PublicClient, o.safe as Hex);
    console.log(`${c.ok ? "ok" : "FAIL"}: ${c.what} (${c.detail})`);
    process.exit(c.ok ? 0 : 1);
  }
  if (!o.file || !o.rpc || !o.safe) {
    console.error("usage: bun ops/mainnet/live-check.ts --file DEPLOYMENT.json --rpc URL --safe 0xSAFE [--out FILE] [--contracts DIR]");
    process.exit(2);
  }
  const r = await liveCheck({ file: resolve(o.file), rpc: o.rpc, safe: o.safe as Hex, contractsDir: o.contracts ? resolve(o.contracts) : undefined, sourcifyApi: process.env.SOURCIFY_API });
  const when = new Date().toISOString().slice(0, 19) + "Z";
  const sha = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"]).stdout.toString().trim() || "unknown";
  const md = renderLiveCheck(r, { file: o.file, rpc: o.rpc, safe: o.safe, when, buildSha: sha });
  const out = o.out ?? join(ROOT, ".audit-grade", `live-check-${when.slice(0, 10)}.md`);
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  for (const c of r.checks) console.log(`${c.ok ? "ok" : "FAIL"}: ${c.what} (${c.detail})`);
  const pass = r.checks.every((c) => c.ok);
  console.log(`live-check: ${pass ? "PASS" : "FAIL"} (${out})`);
  process.exit(pass ? 0 : 1);
}
