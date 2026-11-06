// Compose the facilitator: one exact EVM scheme per network (its own RPC, chain id check and hot-key signer), the
// exact SVM scheme for Solana, chain probes for the reconciler, and the Capstan safety service.
import type { Logger, ServiceSigner } from "@capstan/core";
import { EVM_CHAIN_IDS, facilitatorEvmSigner, trackSvmBroadcast, type EvmNetwork, type SvmNetwork } from "@capstan/x402";
import { createSolanaRpc, type KeyPairSigner, type Signature } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { broadcastTracker, createFacilitatorService, type Alert, type ChainProbe, type ServiceOptions } from "./service";
import type { PaymentStore } from "./store";

export interface BuildOptions {
  evm?: { signer: ServiceSigner; networks: { network: EvmNetwork; rpcUrl: string }[] };
  svm?: { signer: KeyPairSigner; networks: { network: SvmNetwork; rpcUrl: string }[] };
  store: PaymentStore;
  log: Logger;
  alert: (a: Alert) => Promise<void> | void;
  isArmed: () => boolean;
  float?: ServiceOptions["float"];
  floatHolders?: string[];
  receiptTimeoutMs?: number;
  dropAfterMs?: number;
  now?: () => number;
}

export function evmProbe(client: PublicClient): ChainProbe {
  return {
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash: hash as Hex });
        return r.status === "success" ? "success" : "reverted";
      } catch {
        return null;
      }
    },
    async known(hash) {
      try {
        await client.getTransaction({ hash: hash as Hex });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function svmProbe(rpcUrl: string): ChainProbe {
  const rpc = createSolanaRpc(rpcUrl);
  const status = async (sig: string) => (await rpc.getSignatureStatuses([sig as Signature], { searchTransactionHistory: true }).send()).value[0];
  return {
    async receipt(sig) {
      const s = await status(sig);
      if (!s || (s.confirmationStatus !== "confirmed" && s.confirmationStatus !== "finalized")) return null;
      return s.err ? "reverted" : "success";
    },
    async known(sig) {
      return !!(await status(sig));
    },
  };
}

export function buildFacilitator(o: BuildOptions) {
  const facilitator = new x402Facilitator();
  const tracker = broadcastTracker();
  const probes: Record<string, ChainProbe> = {};
  const evmSigners: Partial<Record<EvmNetwork, ReturnType<typeof facilitatorEvmSigner>>> = {};
  for (const n of o.evm?.networks ?? []) {
    const client = createPublicClient({ transport: http(n.rpcUrl, { retryCount: 2 }) }) as PublicClient;
    const signer = facilitatorEvmSigner({ signer: o.evm!.signer, client, chainId: EVM_CHAIN_IDS[n.network], onBroadcast: (h) => tracker.onBroadcast(h), receiptTimeoutMs: o.receiptTimeoutMs });
    evmSigners[n.network] = signer;
    facilitator.register(n.network, new ExactEvmScheme(signer));
    probes[n.network] = evmProbe(client);
  }
  const svmFeePayers: Record<string, string> = {};
  if (o.svm && o.svm.networks.length) {
    const rpcs = Object.fromEntries(o.svm.networks.map((n) => [n.network, createSolanaRpc(n.rpcUrl)]));
    const signer = trackSvmBroadcast(toFacilitatorSvmSigner(o.svm.signer, rpcs as never), (s) => tracker.onBroadcast(s));
    for (const n of o.svm.networks) {
      facilitator.register(n.network, new ExactSvmScheme(signer));
      probes[n.network] = svmProbe(n.rpcUrl);
      svmFeePayers[n.network] = o.svm.signer.address;
    }
  }
  const service = createFacilitatorService({
    facilitator,
    store: o.store,
    tracker,
    probes,
    log: o.log,
    alert: o.alert,
    isArmed: o.isArmed,
    svmFeePayers,
    float: o.float,
    floatHolders: o.floatHolders,
    dropAfterMs: o.dropAfterMs,
    now: o.now,
  });
  return { service, facilitator, evmSigners, probes };
}
