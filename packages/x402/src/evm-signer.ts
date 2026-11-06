// FacilitatorEvmSigner over a Capstan ServiceSigner (keystore-loaded hot key) and a viem public client, for ONE chain.
// - the RPC chain id is asserted before every send (a wrong RPC never gets a signed tx);
// - the tx hash is reported through onBroadcast BEFORE the raw tx is sent, so a crash after broadcast always leaves
//   a settlement_pending row with the hash for the reconciler;
// - sends are serialised per signer (one nonce sequence).
import type { ServiceSigner } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { encodeFunctionData, keccak256, type Abi, type PublicClient } from "viem";

export interface FacilitatorSignerOptions {
  signer: ServiceSigner;
  client: PublicClient;
  chainId: number;
  onBroadcast?: (hash: Hex) => Promise<void> | void;
  /** Receipt wait bound; past it the SDK reports settlement_pending. */
  receiptTimeoutMs?: number;
  /** Gas limit headroom over the estimate, in percent (default 20). */
  gasHeadroomPct?: number;
}

export class ChainMismatchError extends Error {
  constructor(expected: number, got: number) {
    super(`facilitator rpc answers chain ${got}, expected ${expected}`);
    this.name = "ChainMismatchError";
  }
}

export function facilitatorEvmSigner(o: FacilitatorSignerOptions): FacilitatorEvmSigner & { readonly sentHashes: Hex[] } {
  if (!o.signer.signTransaction) throw new Error("service signer cannot sign transactions");
  let queue: Promise<unknown> = Promise.resolve();
  const sentHashes: Hex[] = [];
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const send = (to: Hex, data: Hex, gas?: bigint): Promise<Hex> =>
    serial(async () => {
      const cid = await o.client.getChainId();
      if (cid !== o.chainId) throw new ChainMismatchError(o.chainId, cid);
      const from = o.signer.address;
      const nonce = await o.client.getTransactionCount({ address: from, blockTag: "pending" });
      const est = gas ?? ((await o.client.estimateGas({ account: from, to, data })) * BigInt(100 + (o.gasHeadroomPct ?? 20))) / 100n;
      const fees = await o.client.estimateFeesPerGas();
      const raw = await o.signer.signTransaction!({
        chainId: o.chainId,
        to,
        data,
        nonce,
        gas: est,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      });
      const hash = keccak256(raw);
      await o.onBroadcast?.(hash);
      const sent = await o.client.sendRawTransaction({ serializedTransaction: raw });
      sentHashes.push(sent);
      return sent;
    });
  return {
    sentHashes,
    getAddresses: () => [o.signer.address],
    readContract: (args) => o.client.readContract(args as Parameters<PublicClient["readContract"]>[0]),
    verifyTypedData: (args) => o.client.verifyTypedData(args as Parameters<PublicClient["verifyTypedData"]>[0]),
    writeContract: (args) => send(args.address, encodeFunctionData({ abi: args.abi as Abi, functionName: args.functionName, args: args.args as unknown[] }), args.gas),
    sendTransaction: (args) => send(args.to, args.data),
    waitForTransactionReceipt: async (args) => {
      const r = await o.client.waitForTransactionReceipt({ hash: args.hash, timeout: args.timeout ?? o.receiptTimeoutMs ?? 60_000 });
      return { status: r.status, logs: r.logs };
    },
    getCode: (args) => o.client.getCode(args),
  };
}
