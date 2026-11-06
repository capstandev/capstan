// R7 (todo 31): tool outputs equal the API responses, on a local API built from the real route factories, for
// markets, quote, positions and risk.
import { describe, expect, test } from "bun:test";
import { callTool, localApi, mcp, OWNER, ownerRead } from "./helpers";

describe("golden", () => {
  test("mirror-rest", async () => {
    const { app: api, api: client } = await localApi();
    const m = mcp(client);
    const direct = async (path: string, init?: RequestInit) => (await api.request(`http://api.capstan.test/v1${path}`, init)).json();

    const markets = await callTool(m, "capstan_markets", { asset: "CR:ETH", executableOnly: true });
    expect(markets.structuredContent).toEqual(await direct("/markets?asset=CR%3AETH&executable=true"));
    expect(JSON.parse(markets.content[0]!.text)).toEqual(markets.structuredContent!);
    expect((markets.structuredContent!.markets as unknown[]).length).toBe(1);

    const q = { canonicalAsset: "CR:ETH", side: "buy", sizeBase: "1", leverage: 5, holdHours: 2, orderType: "market" };
    const quote = await callTool(m, "capstan_quote", q);
    const dq = (await direct("/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) })) as Record<string, unknown>;
    // quote ids differ per call; everything else must match
    const strip = (x: Record<string, unknown>) => ({ ...x, requestId: "-", receiptHint: "-" });
    expect(strip(quote.structuredContent!)).toEqual(strip(dq));
    expect((quote.structuredContent!.legs as unknown[]).length).toBeGreaterThan(0);

    const posPath = `/v1/positions?owner=${OWNER}`;
    const positions = await callTool(m, "capstan_positions", { owner: OWNER, ownerRead: ownerRead(posPath) });
    const sig = ownerRead(posPath);
    const dp = await (await api.request(`http://api.capstan.test${posPath}`, { headers: { "x-capstan-message": sig.message, "x-capstan-signature": sig.signature } })).json();
    expect(positions.isError).toBeUndefined();
    expect(positions.structuredContent).toEqual(dp as Record<string, unknown>);

    const riskPath = `/v1/risk?owner=${OWNER}`;
    const risk = await callTool(m, "capstan_risk", { owner: OWNER, ownerRead: ownerRead(riskPath) });
    const rs = ownerRead(riskPath);
    const dr = await (await api.request(`http://api.capstan.test${riskPath}`, { headers: { "x-capstan-message": rs.message, "x-capstan-signature": rs.signature } })).json();
    expect(risk.isError).toBeUndefined();
    expect(risk.structuredContent).toEqual(dr as Record<string, unknown>);

    // an API error comes back as the API's error body, flagged isError
    const bad = await callTool(m, "capstan_positions", { owner: OWNER, ownerRead: ownerRead("/v1/positions?owner=0x0000000000000000000000000000000000000001") });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });
});
