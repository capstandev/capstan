// Give a wallet fork-only funds for a click-through: 10 ETH and 1,000 USDG on the RHC fork (and 10 ETH on the Base
// fork), by anvil balance and storage writes on the local forks only. Usage: bun ops/fork/fund.ts 0xADDRESS
import type { Hex } from "@capstan/schema";
import { setTokenBalance } from "../../packages/x402/test/helpers/chain";
import { BASE, ERC20_ABI, RHC, rhc, setBalance, USDG } from "./lib";

const addr = process.argv[2];
if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
  console.error("usage: bun ops/fork/fund.ts 0xADDRESS");
  process.exit(2);
}
if ((await rhc.getChainId()) !== 4663) throw new Error("the RHC fork is not running (bash ops/fork/up.sh)");
await setBalance(addr as Hex, 10n * 10n ** 18n, RHC);
await setBalance(addr as Hex, 10n * 10n ** 18n, BASE);
await setTokenBalance(RHC, USDG, addr as Hex, 1_000_000_000n);
const usdg = await rhc.readContract({ address: USDG, abi: ERC20_ABI, functionName: "balanceOf", args: [addr as Hex] });
console.log(`funded ${addr} on the forks: 10 ETH (RHC and Base), ${Number(usdg) / 1e6} USDG (RHC)`);
