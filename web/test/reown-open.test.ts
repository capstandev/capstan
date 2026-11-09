// The wallet picker waits for AppKit's setup before it opens (so the WalletConnect row is in the list), but it always
// opens: after the bound when setup is slow, and at once when setup fails.
import { describe, expect, test } from "bun:test";
import { openWhenReady, READY_WAIT_MS } from "../src/app/reown-open";

function fakeKit(ready: () => Promise<void>) {
  const log: string[] = [];
  return {
    log,
    kit: {
      ready: async () => {
        await ready();
        log.push("ready");
      },
      open: async () => {
        log.push("open");
      },
    },
  };
}

describe("openWhenReady", () => {
  test("opens only after setup finishes", async () => {
    let finish!: () => void;
    const { kit, log } = fakeKit(() => new Promise<void>((r) => (finish = r)));
    const opening = openWhenReady(kit, 1_000);
    await Bun.sleep(30);
    expect(log).toEqual([]);
    finish();
    await opening;
    expect(log).toEqual(["ready", "open"]);
  });

  test("opens after the bound when setup never finishes", async () => {
    const { kit, log } = fakeKit(() => new Promise<void>(() => {}));
    const t0 = performance.now();
    await openWhenReady(kit, 60);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
    expect(log).toEqual(["open"]);
  });

  test("opens when setup fails", async () => {
    const { kit, log } = fakeKit(() => Promise.reject(new Error("relay down")));
    await openWhenReady(kit, 1_000);
    expect(log).toEqual(["open"]);
  });

  test("the default bound is a few seconds, not forever", () => {
    expect(READY_WAIT_MS).toBeGreaterThan(0);
    expect(READY_WAIT_MS).toBeLessThanOrEqual(10_000);
  });
});
