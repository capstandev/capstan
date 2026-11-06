// Line coverage gate for packages/ from an lcov file. Usage: bun ops/ci/check-coverage.ts coverage/lcov.info 70
import { readFileSync } from "node:fs";

export function packagesLineCoverage(lcov: string, prefix = "packages/"): { found: number; hit: number; pct: number } {
  let found = 0;
  let hit = 0;
  let inScope = false;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      const p = line.slice(3).replace(/^.*?(packages\/)/, "$1");
      inScope = p.startsWith(prefix) && !/\.test\.ts$/.test(p) && !p.includes("/test/");
    } else if (inScope && line.startsWith("LF:")) found += Number(line.slice(3));
    else if (inScope && line.startsWith("LH:")) hit += Number(line.slice(3));
  }
  return { found, hit, pct: found ? (hit / found) * 100 : 100 };
}

if (import.meta.main) {
  const [file = "coverage/lcov.info", min = "70"] = process.argv.slice(2);
  const r = packagesLineCoverage(readFileSync(file, "utf8"));
  console.log(`check-coverage: packages/ lines ${r.hit}/${r.found} = ${r.pct.toFixed(1)}% (min ${min}%)`);
  if (r.pct < Number(min)) process.exit(1);
}
