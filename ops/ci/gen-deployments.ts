// Writes every generated copy of contracts/deployments/<chainId>.json: the TS module, web/public/contracts.json (the
// token-address box) and the README / SECURITY.md tables between the deployment markers. Usage: bun ops/ci/gen-deployments.ts [repoRoot]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GENERATED_TS, loadDeployments, renderTable, renderTs, renderWebJson, replaceBetweenMarkers, TABLE_FILES, WEB_JSON } from "./deployments";

export function generateDeployments(root: string): void {
  const { deployments, errors } = loadDeployments(root);
  if (errors.length) throw new Error(errors.join("\n"));
  writeFileSync(join(root, GENERATED_TS), renderTs(deployments));
  mkdirSync(dirname(join(root, WEB_JSON)), { recursive: true });
  writeFileSync(join(root, WEB_JSON), renderWebJson(deployments));
  const table = renderTable(deployments);
  for (const f of TABLE_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const next = replaceBetweenMarkers(readFileSync(p, "utf8"), table);
    if (next === null) throw new Error(`${f}: no deployment markers`);
    writeFileSync(p, next);
  }
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  generateDeployments(root);
  console.log("gen-deployments: copies written");
}
