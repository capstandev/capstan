// kit.sh checks the passphrase file mode. GNU stat (Linux) reads `stat -f %Lp FILE` as "file system status of the
// files %Lp and FILE": it prints FILE's file system block and fails on %Lp, so a macOS-first `stat -f || stat -c`
// captured that block plus the mode and refused a 600 file. The order must be GNU first, as in ops/server/lib.sh.
// The stand-in `stat` below behaves like GNU coreutils; the stand-in bun only proves kit.sh got past the check.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KIT = join(import.meta.dir, "..", "kit.sh");
let dir = "";

const GNU_STAT = `#!/bin/bash
if [ "$1" = "-c" ] && [ "$2" = "%a" ]; then /usr/bin/stat -c %a "$3" 2>/dev/null || /usr/bin/stat -f %Lp "$3"; exit $?; fi
if [ "$1" = "-f" ]; then
  printf '  File: "%s"\\n    ID: 0        Namelen: 255     Type: ext2/ext3\\nBlock size: 4096\\n' "$3"
  echo "stat: cannot read file system information for '$2': No such file or directory" >&2
  exit 1
fi
echo "stat: unsupported in this stand-in: $*" >&2; exit 1
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-stat-"));
  writeFileSync(join(dir, "stat"), GNU_STAT, { mode: 0o755 });
  writeFileSync(join(dir, "bun"), "#!/bin/bash\necho BUN-REACHED\n", { mode: 0o755 });
  writeFileSync(join(dir, "pass"), "not a real passphrase\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (mode: number, gnuStat = true) => {
  chmodSync(join(dir, "pass"), mode);
  const p = Bun.spawnSync(["/bin/bash", KIT, "--kit", "hl-core", "--network", "testnet"], {
    env: { PATH: gnuStat ? `${dir}:/usr/bin:/bin` : "/usr/bin:/bin", HOME: dir, GOLIVE_BUN: join(dir, "bun"), GOLIVE_PASSPHRASE_FILE: join(dir, "pass") },
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

describe("kit.sh passphrase mode check with GNU stat (Linux)", () => {
  test("a 600 file passes", () => {
    const r = run(0o600);
    expect(r.out).not.toContain("refused");
    expect(r.out).toContain("BUN-REACHED");
    expect(r.code).toBe(0);
  });
  test("a 400 file passes", () => {
    expect(run(0o400).out).toContain("BUN-REACHED");
  });
  test("a 644 file is refused and the message names 644 only", () => {
    const r = run(0o644);
    expect(r.code).toBe(2);
    expect(r.out).toContain("(it is 644)");
    expect(r.out).not.toContain("BUN-REACHED");
  });
});

test("with the host's own stat (macOS here, GNU on Linux CI) a 600 file passes and a 644 file is refused", () => {
  expect(run(0o600, false).out).toContain("BUN-REACHED");
  expect(run(0o644, false).out).toContain("(it is 644)");
});

test("kit.sh tries the GNU form first, like ops/server/lib.sh", () => {
  const src = require("node:fs").readFileSync(KIT, "utf8") as string;
  const line = src.split("\n").find((l: string) => l.includes("GOLIVE_PASSPHRASE_FILE") && l.includes("stat"));
  expect(line).toBeDefined();
  expect(line!.indexOf("stat -c")).toBeGreaterThan(-1);
  expect(line!.indexOf("stat -c")).toBeLessThan(line!.indexOf("stat -f"));
});
