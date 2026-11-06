// WS test helpers: a gateway on a memory bus and port 0, label-derived test keys, and a client that queues messages.
import { memoryNonceStore } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMessage } from "viem";
import { addressOfSecret, signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { memoryBus } from "../src/bus";
import { createWsGateway, wsSubscribeMessage, type WsDeps } from "../src/server";

export const HOST = "api.capstan.test";
export const wsKey = (l: string) => keccak_256(utf8ToBytes(`capstan-ws-test:${l}`)); // test-key
export const addr = (sk: Uint8Array) => addressOfSecret(sk).toLowerCase() as Hex;

export async function startWs(over: Partial<WsDeps> = {}) {
  const bus = memoryBus();
  const gw = createWsGateway({ bus, host: HOST, nonces: memoryNonceStore(), marketsForAsset: async () => [], bookOf: async () => null, capOf: async () => 50, tickerMs: 50, ...over });
  const server = await gw.start(0);
  return { bus, gw, url: `ws://127.0.0.1:${server.port}/v1`, stop: () => (gw.stop(), server.stop(true)) };
}

export async function client(url: string) {
  const ws = new WebSocket(url);
  const inbox: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    inbox.push(JSON.parse(String(e.data)));
    waiters.splice(0).forEach((w) => w());
  };
  await new Promise<void>((r, j) => ((ws.onopen = () => r()), (ws.onerror = () => j(new Error("ws error")))));
  return {
    ws,
    inbox,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    /** Wait for the first queued message matching `pred` (and remove it). */
    async next(pred: (m: Record<string, unknown>) => boolean = () => true, ms = 2000): Promise<Record<string, unknown>> {
      const end = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0]!;
        if (Date.now() > end) throw new Error(`no matching message within ${ms} ms; have ${JSON.stringify(inbox).slice(0, 300)}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
    close: () => ws.close(),
  };
}

export function signedSub(sk: Uint8Array, channel: string, ts: number, owner = addr(sk)) {
  return { op: "sub", channel, owner, ts, sig: signDigestRsv(hashMessage(wsSubscribeMessage(owner, channel, ts, HOST)), sk) };
}
