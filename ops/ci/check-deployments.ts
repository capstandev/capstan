// Fails when a deployment file is malformed or any generated copy differs from it.
// Usage: bun ops/ci/check-deployments.ts [repoRoot]
import { join, resolve } from "node:path";
import { deploymentDrift } from "./deployments";

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const drift = deploymentDrift(root);
  if (drift.length) {
    for (const d of drift) console.error(`check-deployments: ${d}`);
    process.exit(1);
  }
  console.log("check-deployments: every copy equals contracts/deployments");
}
