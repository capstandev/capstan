// Security review r2, R2-RELAY-01: the gross cap must not trust an Aster positions answer the caller posted. In direct
// mode /v1/risk/ingest stores body.snapshot as sent (only the query signature is checked), and the policed agent can
// post it. After filling most of the cap with an IOC order, an agent posts a fresh direct-mode positionRisk showing dust; the
// next opening order must still be refused. A relay-mode read (the server's own) still frees room.
import { afterAll, describe, expect, test } from "bun:test";
import { buildSignedRead, ingestSignedRead, memoryAccountStore, type AsterAccountSnapshot } from "@capstan/adapter-aster";
import type { Hex, RiskView } from "@capstan/schema";
import { createMemoryGovernor, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { handleSubmit } from "../src/pipeline";
import { exposureFromView } from "../src/stores";
import { ASTER_AGENT, ASTER_AGENT_KEY, ASTER_REF, codeOf, NOW, policyFor, relayStack } from "./helpers";
import { signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { USER_A } from "../../../packages/adapters/hyperliquid/test/orders/util";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));
const DUST = [{ symbol: "BTCUSDT", positionAmt: "0.00001", entryPrice: "76000", markPrice: "76000", unRealizedProfit: "0", liquidationPrice: "0", leverage: "5", marginType: "cross", notional: "0.76", positionSide: "BOTH" }];

async function ingest(kind: "positionRisk" | "balance", at: number, mode: "direct" | "relay", store = memoryAccountStore(() => at), answer: unknown = DUST) {
  const r = buildSignedRead(kind, USER_A, ASTER_AGENT, BigInt(at) * 1000n, "Mainnet");
  const signedRead = { path: r.path, query: r.query, signature: signDigestRsv(r.digest, ASTER_AGENT_KEY), signer: ASTER_AGENT, owner: USER_A, fetchedAtMs: at };
  const server = fakeVenueServer({ [`GET ${r.path}`]: () => Response.json(answer) });
  try {
    const http = venueHttp("aster", server.url, createMemoryGovernor("t"), { maxTries: 1 });
    const snap = await ingestSignedRead(
      { venue: "aster", mode, snapshot: answer, signedRead },
      { network: "Mainnet", delegations: { isActive: async () => true }, store, marginAssetOf: () => "USDT", now: () => at, http },
    );
    return { snap, store };
  } finally {
    server.stop();
  }
}

/** The stored risk view the next risk-compute run writes from this snapshot (shape only matters for perVenue). */
const viewOf = (snap: AsterAccountSnapshot) => ({ perVenue: [JSON.parse(JSON.stringify(snap))] }) as unknown as RiskView;

describe("security r2 R2-RELAY-01", () => {
  test("direct-mode-positions-are-not-a-gross-cap-input", async () => {
    const s = relayStack();
    stacks.push(s);
    s.policies.set(ASTER_REF, { policyId: "pol-aster", policy: policyFor(ASTER_REF, { agents: [{ venue: "aster", agentRef: ASTER_REF }], allowedVenues: ["aster"], maxGrossNotionalUsd: "150", maxNotionalPerOrderUsd: "150" }) });
    let clock = NOW;
    s.deps.now = () => clock;
    let view: RiskView | undefined;
    (s.deps as { exposure?: unknown }).exposure = { openGrossUsd: async (_o: Hex, v: "aster", now: number) => exposureFromView(view, v, now) };
    const submit = async () => {
      const h = s.aster({ type: "limit", tif: "ioc", limitPx: "76000.0", size: "0.010" }); // the build helper prices it at 100 USD (cap 150), not resting
      (s.store.builds.get(h.b.buildId) as { expiresAt: number }).expiresAt = clock + 30_000;
      const st = s.store.builds.get(h.b.buildId) as { policyId?: string | null };
      st.policyId = "pol-aster";
      return codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.70" }, s.deps));
    };
    expect((await submit()).code).toBeNull();
    // the agent posts a fresh direct-mode positionRisk showing dust; risk-compute writes it into the view
    clock = NOW + 5 * 60_000;
    const direct = await ingest("positionRisk", clock - 1000, "direct");
    expect(direct.snap.positionsSource).toBe("client_read");
    view = viewOf(direct.snap);
    const r = await submit();
    expect(r.code).toBe("POLICY_BREACH");
    expect(r.field).toBe("maxGrossNotionalUsd");
    // a relay-mode balance read after it does not launder the client's positions
    const mixed = await ingest("balance", clock - 500, "relay", direct.store, [{ asset: "USDT", balance: "1000", crossUnPnl: "0", availableBalance: "900" }]);
    expect(mixed.snap.source).toBe("relay_read");
    expect(mixed.snap.positionsSource).toBe("client_read");
    view = viewOf(mixed.snap);
    expect(exposureFromView(view, "aster", clock)).toBeNull();
    expect((await submit()).code).toBe("POLICY_BREACH");
  });

  test("relay-mode-positions-still-count", async () => {
    const at = NOW + 60_000;
    const relay = await ingest("positionRisk", at, "relay");
    expect(relay.snap.positionsSource).toBe("relay_read");
    expect(exposureFromView(viewOf(relay.snap), "aster", at + 1000)).toEqual({ grossUsd: "0.76", asOfMs: at });
    // the positions time is the positions read, not a later balance read
    const later = await ingest("balance", at + 4 * 60_000, "relay", relay.store, [{ asset: "USDT", balance: "1", crossUnPnl: "0", availableBalance: "1" }]);
    expect(exposureFromView(viewOf(later.snap), "aster", at + 5 * 60_000)!.asOfMs).toBe(at);
    // a stored Aster entry with no positions provenance (written before this fix) is not trusted either
    const { positionsSource: _a, positionsAsOf: _b, ...old } = relay.snap;
    expect(exposureFromView(viewOf(old as AsterAccountSnapshot), "aster", at + 1000)).toBeNull();
  });
});
