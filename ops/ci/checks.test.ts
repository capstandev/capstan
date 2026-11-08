// Tests for the CI invariant checks: each must fail on a planted violation and pass on clean input.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { findBannedWords } from "./check-banned-words";
import { packagesLineCoverage } from "./check-coverage";
import { findKeyIdentifiers } from "./check-key-identifiers";
import { contractsIn, missingNotices } from "./check-natspec";
import { findPinProblems } from "./check-pins";
import { findKeyishNames } from "./check-vector-files";
import { deploymentDrift, END, renderTable, renderWebJson, START, WEB_JSON } from "./deployments";
import { generateDeployments } from "./gen-deployments";
import { lex } from "./lex";
import { loadAllow, parseSlither, unallowed } from "./run-slither";

const roots: string[] = [];
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "capstan-ci-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("lex", () => {
  test("blanks comments and strings, keeps template expressions as code", () => {
    const { code, strings } = lex('const a = "x"; // note\nconst b = `t ${c} u`; /* d */');
    expect(code).toContain("const a");
    expect(code).not.toContain("note");
    expect(code).toContain("${c}");
    expect(code).not.toContain(" d ");
    expect(strings.map((s) => s.value)).toEqual(["x", "t ", " u"]);
  });
});

describe("check-key-identifiers", () => {
  test("planted-privateKey", () => {
    const root = repo({ "apps/api/src/bad.ts": "export function sign(privateKey: string) { return privateKey; }\n" });
    const hits = findKeyIdentifiers(root);
    expect(hits.length).toBe(2);
    expect(hits[0]).toEqual({ file: "apps/api/src/bad.ts", line: 1, name: "privateKey" });
  });
  test("fails on seed and mnemonic identifiers, any case, and quoted property names", () => {
    const root = repo({
      "apps/relay/src/a.ts": 'const userSeed = 1;\nconst MNEMONIC = 2;\nconst o: Record<string, number> = {};\no["privateKey"] = 3;\n',
    });
    expect(findKeyIdentifiers(root).map((h) => h.name)).toEqual(["userSeed", "MNEMONIC", '"privateKey"']);
  });
  test("ignores comments and prose strings, and packages/sdk", () => {
    const root = repo({
      "apps/mcp/src/ok.ts": '// never accepts a privateKey\nexport const d = "no tool takes a seed phrase";\n',
      "packages/sdk/src/key.ts": "export const privateKey = 1;\n",
    });
    expect(findKeyIdentifiers(root)).toEqual([]);
  });
  test("the real repo is clean", () => {
    expect(findKeyIdentifiers(join(import.meta.dir, "../.."))).toEqual([]);
  });
});

describe("check-banned-words", () => {
  test("fails on a planted word in a doc and in an API string", () => {
    const root = repo({
      "README.md": "# X\nA risk-free carry.\n",
      "apps/api/src/copy.ts": 'export const m = "Guaranteed returns";\n',
    });
    const hits = findBannedWords(root);
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(["README.md:2", "apps/api/src/copy.ts:1"]);
  });
  test("catches endorsement and shared-margin claims", () => {
    const root = repo({ "web/index.html": "<p>Official Hyperliquid API with unified margin</p>\n" });
    expect(findBannedWords(root).length).toBe(2);
  });
  test("skips venue wire formats, tests and code comments", () => {
    const root = repo({
      "packages/adapters/hyperliquid/src/a.ts": 'export const mode = "cross margin";\n',
      "apps/api/src/a.test.ts": 'const x = "risk-free";\n',
      "apps/api/src/b.ts": "// risk-free is banned\nexport const y = 1;\n",
    });
    expect(findBannedWords(root)).toEqual([]);
  });
  test("the real repo is clean", () => {
    expect(findBannedWords(join(import.meta.dir, "../.."))).toEqual([]);
  });
});

const REAL = join(import.meta.dir, "../..");

describe("check-pins", () => {
  test("pins", () => {
    const clean = repo({
      "package.json": JSON.stringify({ devDependencies: { typescript: "5.9.3" } }),
      "packages/a/package.json": JSON.stringify({ dependencies: { "@capstan/core": "workspace:*", zod: "4.6.7" } }),
      ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0\n      - uses: ./local\n    container:\n      image: x/y:1@sha256:" + "a".repeat(64) + "\n",
    });
    expect(findPinProblems(clean)).toEqual([]);
    const caret = repo({ "packages/a/package.json": JSON.stringify({ dependencies: { zod: "^1.0.0", hono: "~4.0.0", x: "latest", y: ">=1" } }) });
    expect(findPinProblems(caret).map((p) => p.what)).toEqual([
      'dependencies.zod is "^1.0.0", not an exact version',
      'dependencies.hono is "~4.0.0", not an exact version',
      'dependencies.x is "latest", not an exact version',
      'dependencies.y is ">=1", not an exact version',
    ]);
    const tag = repo({ ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: docker://alpine:3\n    services:\n      pg:\n        image: postgres:16\n" });
    expect(findPinProblems(tag).map((p) => `${p.line}:${p.what}`)).toEqual([
      "4:action not pinned by full sha: actions/checkout@v4",
      "5:action not pinned by full sha: docker://alpine:3",
      "5:image not pinned by digest: alpine:3",
      "8:image not pinned by digest: postgres:16",
    ]);
    // a workspace:* is only allowed for our own packages
    expect(findPinProblems(repo({ "package.json": JSON.stringify({ dependencies: { lodash: "workspace:*" } }) })).length).toBe(1);
  });
  test("the real repo is clean", () => {
    expect(findPinProblems(REAL)).toEqual([]);
  });
  // r1:9 F-5: web/ has its own bunfig.toml, so the root supply-chain delay does not cover its installs
  test("every bunfig.toml keeps exact versions and the 3-day supply-chain delay", () => {
    const ok = "[install]\nexact = true\nminimumReleaseAge = 259200\n";
    expect(findPinProblems(repo({ "bunfig.toml": ok, "web/bunfig.toml": ok }))).toEqual([]);
    expect(findPinProblems(repo({ "bunfig.toml": ok, "web/bunfig.toml": "[test]\npreload = []\n" })).map((p) => `${p.file}:${p.what}`)).toEqual([
      "web/bunfig.toml:no [install] exact = true",
      "web/bunfig.toml:no [install] minimumReleaseAge of at least 259200 seconds",
    ]);
    expect(findPinProblems(repo({ "web/bunfig.toml": "[install]\nexact = true\nminimumReleaseAge = 60\n" })).map((p) => p.what)).toEqual(["no [install] minimumReleaseAge of at least 259200 seconds"]);
  });
});

// r1:9 F-5: the web dashboard (keys and signing screens) was never installed, built or tested in CI
describe("ci runs the web package", () => {
  const ci = readFileSync(join(REAL, ".github/workflows/ci.yml"), "utf8");
  const job = (name: string) => {
    const m = ci.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`));
    return m ? m[1]! : "";
  };
  test("a web job installs frozen, builds (with check-dist), tests and checks copy, and ci-summary needs it", () => {
    const web = job("web");
    expect(web).toContain("working-directory: web");
    expect(web).toContain("bun install --frozen-lockfile");
    expect(web).toContain("bun run build");
    expect(web).toContain("bun run test");
    expect(web).toContain("bun run check:copy");
    expect(job("ci-summary")).toMatch(/needs: \[[^\]]*\bweb\b[^\]]*\]/);
  });
});

describe("check-deployments", () => {
  const dep = {
    chainId: 46630,
    contracts: { CapstanReceiptAnchor: { address: "0x00000000000000000000000000000000000000a1", poster: "0x00000000000000000000000000000000000000b2", block: 7 } },
    deployer: "0x00000000000000000000000000000000000000c3",
    sourcify: { verified: true, url: "https://sourcify.example/46630/a1" },
    updatedAt: "2026-11-05T00:00:00Z",
  };
  const docs = (table: string) => `# X\n${START}\n${table}\n${END}\n`;
  function deployRepo(): string {
    const root = repo({
      "contracts/deployments/46630.json": JSON.stringify(dep),
      "README.md": docs("stale"),
      "SECURITY.md": docs("stale"),
      "packages/schema/src/generated/deployments.ts": "",
    });
    copyFileSync(join(import.meta.dir, "deployments.header.ts.txt"), join(root, "deployments.header.ts.txt"));
    return root;
  }
  test("deployments-equal", () => {
    const root = deployRepo();
    expect(deploymentDrift(root).length).toBe(4); // ts module, web json and both tables differ
    generateDeployments(root);
    expect(deploymentDrift(root)).toEqual([]);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("| Robinhood Chain testnet (`46630`) | `CapstanReceiptAnchor` | `0x00000000000000000000000000000000000000a1` | [verified](https://sourcify.example/46630/a1) |");
    // hand-edit the README table: the check fails on README only
    writeFileSync(join(root, "README.md"), readme.replace("00a1`", "00a9`"));
    expect(deploymentDrift(root)).toEqual(["README.md: deployment table differs from contracts/deployments (run bun ops/ci/gen-deployments.ts)"]);
    const gen = readFileSync(join(root, "packages/schema/src/generated/deployments.ts"), "utf8");
    expect(gen).toContain('"chainId": 46630');
  });
  test("malformed deployment files and missing markers fail", () => {
    const root = deployRepo();
    writeFileSync(join(root, "contracts/deployments/46630.json"), JSON.stringify({ ...dep, chainId: 4663, deployer: "nope" }));
    writeFileSync(join(root, "SECURITY.md"), "# no markers\n");
    const d = deploymentDrift(root);
    expect(d).toContain("contracts/deployments/46630.json: file name must equal chainId");
    expect(d).toContain("contracts/deployments/46630.json: deployer must be an address");
    expect(d).toContain("SECURITY.md: no <!-- deployments:start --> ... <!-- deployments:end --> markers");
  });
  test("cpst-copy-equal", () => {
    const root = deployRepo();
    const withCpst = { ...dep, contracts: { ...dep.contracts, CPST: { address: "0x00000000000000000000000000000000000000d4", symbol: "CPST", decimals: 18, supply: "1000000000" } } };
    writeFileSync(join(root, "contracts/deployments/46630.json"), JSON.stringify(withCpst));
    generateDeployments(root);
    expect(deploymentDrift(root)).toEqual([]);
    const web = JSON.parse(readFileSync(join(root, WEB_JSON), "utf8"));
    expect(web.cpst["46630"]).toEqual({ address: "0x00000000000000000000000000000000000000d4", symbol: "CPST", decimals: 18, supply: "1000000000", anchor: "0x00000000000000000000000000000000000000a1" });
    // change the file: every copy is stale until regenerated
    const moved = { ...withCpst, contracts: { ...withCpst.contracts, CPST: { ...withCpst.contracts.CPST, address: "0x00000000000000000000000000000000000000d5" } } };
    writeFileSync(join(root, "contracts/deployments/46630.json"), JSON.stringify(moved));
    const d = deploymentDrift(root);
    expect(d).toContain(`${WEB_JSON} differs from contracts/deployments (run bun ops/ci/gen-deployments.ts)`);
    expect(d).toContain("packages/schema/src/generated/deployments.ts differs from contracts/deployments (run bun ops/ci/gen-deployments.ts)");
    generateDeployments(root);
    expect(deploymentDrift(root)).toEqual([]);
    // wrong decimals or symbol in the file is refused outright
    writeFileSync(join(root, "contracts/deployments/46630.json"), JSON.stringify({ ...moved, contracts: { ...moved.contracts, CPST: { ...moved.contracts.CPST, decimals: 6, symbol: "CPS" } } }));
    const bad = deploymentDrift(root);
    expect(bad).toContain("contracts/deployments/46630.json: CPST.decimals must be 18");
    expect(bad).toContain('contracts/deployments/46630.json: CPST.symbol must be "CPST"');
    // no CPST: the box data is empty (hidden)
    expect(JSON.parse(renderWebJson([])).cpst).toEqual({});
  });
  test("no deployment files: empty tables pass, and the real repo is in sync", () => {
    expect(renderTable([])).toBe("No contracts are deployed yet.");
    expect(deploymentDrift(REAL)).toEqual([]);
  });
});

/** Run .githooks/public-guard.sh inside a throwaway git repo holding `files`. */
function guard(files: Record<string, string>): { code: number; out: string } {
  const root = repo({ ...files, ".githooks/public-guard.denylist": "\\bnot-a-real-private-word\\b\n" });
  copyFileSync(join(REAL, ".githooks/public-guard.sh"), join(root, ".githooks/public-guard.sh"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  const p = spawnSync("bash", [".githooks/public-guard.sh"], { cwd: root, encoding: "utf8" });
  return { code: p.status ?? -1, out: `${p.stdout}${p.stderr}` };
}

describe("fixture allowlist", () => {
  const hex = "0x" + "ab12".repeat(16);
  test("fixture-allowlist-narrow", () => {
    // recorded venue data may hold 64-hex tx and order hashes
    expect(guard({ "packages/venue-client/fixtures/hl/userFills.json": `{"hash":"${hex}"}\n` }).code).toBe(0);
    // a 64-hex in apps/ (or any other fixtures folder) still fails
    const app = guard({ "apps/api/src/x.ts": `export const h = "${hex}";\n` });
    expect(app.code).toBe(1);
    expect(app.out).toContain("possible private key: apps/api/src/x.ts");
    expect(guard({ "packages/adapters/hyperliquid/fixtures/a.json": `{"h":"${hex}"}\n` }).code).toBe(1);
    // a planted key-like name in a fixture or a vectors file fails the vector check
    const fx = repo({
      "packages/venue-client/fixtures/hl/meta.json": '{"universe":[],"privateKey":"x"}\n',
      "packages/signers/hl/test/vectors/order.ts": 'export const v = { testKey: "x" };\nexport const ok = { sig: "y" };\n',
      "packages/signers/hl/test/vectors/sdk.ts": 'export const SDK = { privateKey: "0x01" }; // test-key gitleaks:allow\n',
    });
    expect(findKeyishNames(fx).map((h) => `${h.file}:${h.line}:${h.name}`)).toEqual([
      "packages/signers/hl/test/vectors/order.ts:1:testKey",
      "packages/venue-client/fixtures/hl/meta.json:1:privateKey",
    ]);
    expect(findKeyishNames(REAL)).toEqual([]);
  });
});

describe("banned-word allowlist", () => {
  test("banner-allowed-exact-only", () => {
    const banner = "Each venue liquidates independently. Nothing here is shared margin.";
    const ok = repo({ "packages/risk/src/banner.ts": `export const b = "${banner}";\n`, "README.md": `> ${banner}\n` });
    expect(findBannedWords(ok)).toEqual([]);
    const bad = repo({
      "packages/risk/src/a.ts": 'export const b = "We offer shared margin.";\n',
      "README.md": `${banner} Also shared collateral.\n`,
      "web/i.html": "<p>Nothing here is shared margin</p>\n", // not the exact sentence (no period)
    });
    expect(findBannedWords(bad).map((h) => h.file)).toEqual(["README.md", "web/i.html", "packages/risk/src/a.ts"]);
  });
});

describe("coverage, natspec and slither helpers", () => {
  test("packages line coverage from lcov", () => {
    const lcov = ["SF:/x/packages/a/src/a.ts", "LF:10", "LH:8", "end_of_record", "SF:/x/apps/api/src/b.ts", "LF:100", "LH:0", "end_of_record", "SF:packages/a/test/t.ts", "LF:5", "LH:0", "end_of_record"].join("\n");
    expect(packagesLineCoverage(lcov)).toEqual({ found: 10, hit: 8, pct: 80 });
  });
  test("natspec: functions without @notice are listed; interfaces are skipped", () => {
    const abi = [
      { type: "function", name: "postRoot", inputs: [{ type: "uint64" }, { type: "bytes32" }, { type: "uint32" }] },
      { type: "function", name: "verify", inputs: [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32[]" }] },
      { type: "event", name: "RootPosted" },
    ];
    expect(missingNotices(abi, { methods: { "postRoot(uint64,bytes32,uint32)": { notice: "Posts" } } })).toEqual(["verify(uint64,bytes32,bytes32[])"]);
    const root = repo({ "contracts/src/A.sol": "// contract Fake {}\ncontract Anchor {}\nabstract contract Base {}\n", "contracts/src/interfaces/I.sol": "contract NotMe {}\n" });
    expect(contractsIn(root)).toEqual(["Anchor", "Base"]);
  });
  test("slither: only exact allow-list entries pass", () => {
    const json = { results: { detectors: [
      { check: "reentrancy-eth", description: "x\ny", elements: [{ type: "function", name: "lock", type_specific_fields: { parent: { name: "CPSTLock" } } }] },
      { check: "timestamp", description: "t", elements: [{ type: "function", name: "unlock", type_specific_fields: { parent: { name: "CPSTLock" } } }] },
    ] } };
    const allow = loadAllow("# c\ntimestamp | CPSTLock | unlock | unlockAt is a day-scale bound\n");
    expect(unallowed(parseSlither(json), allow).map((f) => f.check)).toEqual(["reentrancy-eth"]);
  });
});
