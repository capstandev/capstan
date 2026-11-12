// npm publish workflow shape check (r3d-05): the OIDC token and the npm token live only in a publish job that runs
// no project or dependency code and waits on a GitHub environment (a reviewer approves each run). Build and tests run
// in a job with no id-token.
// Usage: bun ops/ci/check-publish-workflow.ts [repoRoot]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PUBLISH_WORKFLOW = ".github/workflows/npm-publish.yml";

type Step = { uses?: string; run?: string; env?: Record<string, unknown> };
type Job = { permissions?: unknown; environment?: unknown; needs?: string | string[]; env?: Record<string, unknown>; steps?: Step[] };

const idTokenWrite = (p: unknown) => p === "write-all" || (typeof p === "object" && p !== null && (p as Record<string, unknown>)["id-token"] === "write");
const hasEnv = (env: unknown, key: string) => typeof env === "object" && env !== null && key in env;
// Steps that run code from the repo or the dependency tree.
const RUNS_PROJECT_CODE = /\b(bun|bunx|yarn|pnpm)\b|npm (ci|install(?! -g --ignore-scripts "npm@)|run|test|exec|pack)\b|\bnode\s+\S+\.m?[jt]s\b|\bnpx\b/;

export function publishWorkflowProblems(text: string): string[] {
  const out: string[] = [];
  let wf: { permissions?: unknown; env?: unknown; jobs?: Record<string, Job> };
  try {
    wf = Bun.YAML.parse(text) as typeof wf;
  } catch (e) {
    return [`not valid YAML: ${(e as Error).message}`];
  }
  if (idTokenWrite(wf.permissions)) out.push("workflow-level permissions grant id-token: write (every job gets it)");
  if (hasEnv(wf.env, "NODE_AUTH_TOKEN")) out.push("NODE_AUTH_TOKEN is set at workflow level");
  const jobs = Object.entries(wf.jobs ?? {});
  const minting = jobs.filter(([, j]) => idTokenWrite(j.permissions) || (j.permissions === undefined && idTokenWrite(wf.permissions)));
  if (minting.length !== 1) out.push(`id-token: write must be in exactly one job, found ${minting.length} (${minting.map(([n]) => n).join(", ") || "none"})`);
  for (const [name, job] of jobs) {
    const steps = job.steps ?? [];
    const mints = minting.some(([n]) => n === name);
    if (hasEnv(job.env, "NODE_AUTH_TOKEN")) out.push(`job ${name}: NODE_AUTH_TOKEN is set at job level, not on the publish step`);
    for (const s of steps) {
      if (hasEnv(s.env, "NODE_AUTH_TOKEN") && !(mints && /\bnpm publish\b/.test(s.run ?? ""))) out.push(`job ${name}: NODE_AUTH_TOKEN on a step that is not the npm publish step of the id-token job`);
    }
    if (!mints) continue;
    if (!job.environment) out.push(`job ${name}: has id-token: write but no environment (no reviewer gates the publish)`);
    if (!job.needs || (Array.isArray(job.needs) && job.needs.length === 0)) out.push(`job ${name}: has id-token: write but needs no build job`);
    for (const s of steps) {
      if (s.uses && /^actions\/checkout@/.test(s.uses)) out.push(`job ${name}: checks out the repo in the id-token job`);
      if (s.run && RUNS_PROJECT_CODE.test(s.run)) out.push(`job ${name}: runs project or dependency code in the id-token job: ${s.run.split("\n")[0]}`);
    }
    if (!steps.some((s) => s.uses && /^actions\/download-artifact@/.test(s.uses))) out.push(`job ${name}: does not download the built tarball`);
  }
  return out;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const problems = publishWorkflowProblems(readFileSync(join(root, PUBLISH_WORKFLOW), "utf8"));
  for (const p of problems) console.error(`check-publish-workflow: ${p}`);
  if (problems.length) process.exit(1);
  console.log("check-publish-workflow: id-token and the npm token only in the gated publish job");
}
