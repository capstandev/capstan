// The one mainnet go change (launch-day run sheet, step 3): fill-go-commit.sh writes the deployment record, its
// generated copies and the SDK anchor pin, refuses a wrong record, and the committed tree is always in one of two
// states: before the go (no 4663 record, no pin) or after it (record, copies and pin all agree).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GO_RECORD, MAINNET_CHAIN_ID, PINS_FILE, pinMainnetAnchor } from "../fill-go-commit";

const ROOT = join(import.meta.dir, "../../..");
const SCRIPT = join(ROOT, "ops/mainnet/fill-go-commit.sh");
const COPIED = ["contracts/deployments/46630.json", "README.md", "SECURITY.md", PINS_FILE, "ops/mainnet/inputs.conf", "web/public/contracts.json", "packages/schema/src/generated/deployments.ts"];
const read = (root: string, f: string): string => readFileSync(join(root, f), "utf8");
// stand-in addresses, built at run time: no real contract lives at any of them
const fake = (byte: string): string => `0x${byte.repeat(20)}`;
const ANCHOR = fake("5a");
const LOCK = fake("6b");
const CPST = fake("7c");
const POSTER = /^POSTER_ADDRESS=(0x[0-9a-fA-F]{40})$/m.exec(read(ROOT, "ops/mainnet/inputs.conf"))![1]!;

function record(over: Record<string, unknown> = {}, contracts: Record<string, unknown> = {}): string {
  const base = {
    chainId: MAINNET_CHAIN_ID,
    contracts: {
      CapstanReceiptAnchor: { address: ANCHOR, block: 100, poster: POSTER },
      CPSTLock: { address: LOCK, block: 101 },
      CPST: { address: CPST, block: 99, symbol: "CPST", decimals: 18, supply: "1000000000" },
      ...contracts,
    },
    deployer: fake("d4"),
    sourcify: { verified: true, url: `https://repo.sourcify.dev/${MAINNET_CHAIN_ID}/${ANCHOR}` },
    updatedAt: "2026-11-20T00:00:00Z",
  };
  return `${JSON.stringify({ ...base, ...over }, null, 2)}\n`;
}

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "capstan-go-fill-"));
  for (const f of COPIED) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  return dir;
}

function run(dir: string, text: string, ...flags: string[]): { code: number; out: string } {
  const file = join(dir, "record-from-deploy.json");
  writeFileSync(file, text);
  const r = spawnSync("/bin/bash", [SCRIPT, file, dir, ...flags], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const mainnetPin = (root: string): string | null => JSON.parse(read(root, PINS_FILE)).networks.mainnet.anchor.address;

describe("fill-go-commit", () => {
  test("a good record fills every go file, and a second run changes nothing", () => {
    const dir = sandbox();
    const text = record();
    const r = run(dir, text);
    expect(r).toEqual({ code: 0, out: expect.stringContaining("files written") });
    for (const f of [GO_RECORD, "packages/schema/src/generated/deployments.ts", "web/public/contracts.json", "README.md", "SECURITY.md", PINS_FILE]) expect(r.out).toContain(`wrote ${f}\n`);
    expect(read(dir, GO_RECORD)).toBe(text);
    const web = JSON.parse(read(dir, "web/public/contracts.json")).cpst;
    expect(web[MAINNET_CHAIN_ID]).toEqual({ address: CPST, symbol: "CPST", decimals: 18, supply: "1000000000", lock: LOCK, anchor: ANCHOR });
    expect(web["46630"]).toEqual(JSON.parse(read(ROOT, "web/public/contracts.json")).cpst["46630"]);
    expect(read(dir, "packages/schema/src/generated/deployments.ts")).toContain(ANCHOR);
    for (const f of ["README.md", "SECURITY.md"]) for (const a of [ANCHOR, LOCK, CPST]) expect({ f, a, has: read(dir, f).includes(a) }).toEqual({ f, a, has: true });
    expect(mainnetPin(dir)).toBe(ANCHOR);
    // only the mainnet anchor line of the pins changed, and the inputs are untouched
    const was = read(ROOT, PINS_FILE).split("\n");
    const now = read(dir, PINS_FILE).split("\n");
    expect(now.length).toBe(was.length);
    expect(now.filter((l, i) => l !== was[i])).toEqual([`        "address": "${ANCHOR}"`]);
    expect(read(dir, "ops/mainnet/inputs.conf")).toBe(read(ROOT, "ops/mainnet/inputs.conf"));
    const again = run(dir, text);
    expect(again.code).toBe(0);
    expect(again.out).toContain("fill-go-commit: 0 files written");
  });

  test("a wrong record is refused and nothing is written", () => {
    const testnet = JSON.parse(read(ROOT, "contracts/deployments/46630.json"));
    const cases: [string, string, RegExp][] = [
      ["testnet chain", record({ chainId: 46630 }), /chainId|file name/],
      ["no lock", record({}, { CPSTLock: undefined }), /CPSTLock is missing/],
      ["another poster", record({}, { CapstanReceiptAnchor: { address: ANCHOR, poster: fake("ee") } }), /is not POSTER_ADDRESS/],
      ["no poster", record({}, { CapstanReceiptAnchor: { address: ANCHOR } }), /poster is missing/],
      ["not verified", record({ sourcify: { verified: false } }), /sourcify.verified is false/],
      ["the testnet token", record({}, { CPST: { address: testnet.contracts.CPST.address, symbol: "CPST", decimals: 18, supply: "1000000000" } }), /equals 46630.json CPST/],
      ["a wallet as the lock", record({}, { CPSTLock: { address: POSTER } }), /equals inputs.conf POSTER_ADDRESS/],
      ["one address twice", record({}, { CPSTLock: { address: ANCHOR } }), /share one address/],
      ["wrong ticker", record({}, { CPST: { address: CPST, symbol: "CAP", decimals: 18, supply: "1000000000" } }), /CPST.symbol/],
    ];
    for (const [name, text, why] of cases) {
      const dir = sandbox();
      const r = run(dir, text);
      expect({ name, code: r.code, why: why.test(r.out) }).toEqual({ name, code: 1, why: true });
      for (const f of COPIED) expect({ name, f, same: read(dir, f) === read(ROOT, f) }).toEqual({ name, f, same: true });
      expect(existsSync(join(dir, GO_RECORD))).toBe(false);
    }
    const dir = sandbox();
    expect(run(dir, record({ sourcify: { verified: false } }), "--allow-unverified").code).toBe(0);
    expect(spawnSync("/bin/bash", [SCRIPT], { encoding: "utf8" }).status).toBe(2);
  });

  test("the pin edit touches the mainnet anchor only and fails loudly on an unknown shape", () => {
    const pins = read(ROOT, PINS_FILE);
    const next = JSON.parse(pinMainnetAnchor(pins, ANCHOR));
    const was = JSON.parse(pins);
    expect(next.networks.testnet).toEqual(was.networks.testnet);
    expect({ ...next.networks.mainnet, anchor: null }).toEqual({ ...was.networks.mainnet, anchor: null });
    expect(() => pinMainnetAnchor("{}", ANCHOR)).toThrow(/expected one mainnet anchor block, found 0/);
  });

  test("the script is offline: no network call, no signing, no git", () => {
    const src = read(ROOT, "ops/mainnet/fill-go-commit.ts") + read(ROOT, "ops/mainnet/fill-go-commit.sh");
    expect(src).not.toMatch(/fetch\(|https?:\/\/|createPublicClient|createWalletClient|\bcast\b|\bforge\b|git (add|commit|push)/);
  });

  test("the committed tree is before the go or after it, never in between", () => {
    const pin = mainnetPin(ROOT);
    const web = JSON.parse(read(ROOT, "web/public/contracts.json")).cpst;
    if (!existsSync(join(ROOT, GO_RECORD))) {
      // before the go: TODO(go) fill-go-commit.sh writes the record, the copies and the pin in one change
      expect({ pin, web: web[MAINNET_CHAIN_ID] }).toEqual({ pin: null, web: undefined });
      return;
    }
    const d = JSON.parse(read(ROOT, GO_RECORD));
    expect(d.sourcify.verified).toBe(true);
    expect(pin).toBe(d.contracts.CapstanReceiptAnchor.address);
    expect(d.contracts.CapstanReceiptAnchor.poster.toLowerCase()).toBe(POSTER.toLowerCase());
    expect(web[MAINNET_CHAIN_ID]).toEqual({ address: d.contracts.CPST.address, symbol: "CPST", decimals: 18, supply: "1000000000", lock: d.contracts.CPSTLock.address, anchor: d.contracts.CapstanReceiptAnchor.address });
  });
});
