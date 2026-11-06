// The VPS env templates in ops/server/etc must boot their service: each one, with provision.sh's placeholders filled,
// passes its role's config, and every drop-in job is listed in exactly one worker env's WORKER_JOBS (the runner treats
// WORKER_JOBS as an explicit list, so a job missing from all three never runs on the server).
import { loadConfig, requiredConfigNames, SERVER_ENV, type Role } from "@capstan/core";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverJobs } from "../src/runner";

const SERVER = join(import.meta.dir, "../../../ops/server");
const ETC = join(SERVER, "etc");

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(file, "utf8")
    .replaceAll("@DB_PASSWORD@", "pw")
    .replaceAll("@API_HOST@", "api.example.com")
    .replaceAll("@RELAY_EGRESS_IP@", "203.0.113.10")
    .replaceAll("@SVC@", "svc");
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** The role a unit runs, read from its ExecStart (apps/<role>/src/index.ts). */
function roleOf(service: string): Role {
  const unit = readFileSync(join(SERVER, "systemd", `capstan-${service}.service`), "utf8");
  const m = /apps\/([a-z]+)\/src\/index\.ts/.exec(unit);
  if (!m) throw new Error(`capstan-${service}.service: no app in ExecStart`);
  return m[1] as Role;
}

const envFiles = readdirSync(ETC).filter((f) => f.endsWith(".env")).sort();

describe("vps env templates", () => {
  test("every template is committed", () => {
    expect(envFiles).toEqual(["anchor.env", "api.env", "facilitator.env", "mcp.env", "receipts.env", "relay.env", "workers.env", "ws.env"]);
  });

  for (const f of envFiles) {
    test(`${f} passes its role's config`, () => {
      const service = f.replace(/\.env$/, "");
      const role = roleOf(service);
      const env = parseEnv(join(ETC, f));
      // keystore paths point at files that exist only on the server; config checks names, not files
      const cfg = loadConfig(role, env) as unknown as Record<string, unknown>;
      expect(cfg.role).toBe(role);
      expect(cfg.CAPSTAN_NETWORK).toBe("testnet");
    });
  }

  for (const f of envFiles) {
    test(`${f} sets every variable its role requires on the server`, () => {
      const service = f.replace(/\.env$/, "");
      const role = roleOf(service);
      const env = parseEnv(join(ETC, f));
      const want = new Set([...requiredConfigNames(role), ...SERVER_ENV[role]]);
      // the geo folder matters to a worker env only when it runs the job that writes the file
      if (role === "workers" && (env.WORKER_JOBS ?? "").split(",").map((j) => j.trim()).includes("geo-db-refresh")) want.add("CAPSTAN_GEO_DIR");
      const missing = [...want].filter((n) => env[n] === undefined).sort();
      expect(missing, `${f} lacks`).toEqual([]);
    });
  }

  test("api-behind-proxy: the api trusts the proxy's X-Forwarded-For and every geo reader and writer shares one folder", () => {
    const api = loadConfig("api", parseEnv(join(ETC, "api.env")));
    expect(api.CAPSTAN_TRUST_FORWARDED_FOR).toBe(true);
    const relay = loadConfig("relay", parseEnv(join(ETC, "relay.env")));
    const workers = loadConfig("workers", parseEnv(join(ETC, "workers.env")));
    expect(api.CAPSTAN_GEO_DIR).toBe("/var/lib/capstan/geo");
    expect(relay.CAPSTAN_GEO_DIR).toBe(api.CAPSTAN_GEO_DIR);
    expect(workers.CAPSTAN_GEO_DIR).toBe(api.CAPSTAN_GEO_DIR);
    // provision makes the folder, the workers unit may write it, Caddy overwrites X-Forwarded-For with the real peer
    expect(readFileSync(join(SERVER, "provision.sh"), "utf8")).toContain("fix_dir /var/lib/capstan/geo 755 capstan-workers:capstan-workers");
    expect(readFileSync(join(SERVER, "systemd", "capstan-workers.service"), "utf8")).toMatch(/^ReadWritePaths=.*\/var\/lib\/capstan\/geo/m);
    const caddy = readFileSync(join(SERVER, "Caddyfile.tmpl"), "utf8");
    expect(caddy.match(/reverse_proxy 127\.0\.0\.1:871[03] \{\s*header_up X-Forwarded-For \{remote_host\}/g)?.length).toBe(2);
  });

  test("local defaults stay safe: no forwarded-for trust unless set", () => {
    expect(loadConfig("api", { DATABASE_URL: "postgres://x@h/x", REDIS_URL: "redis://h:1" }).CAPSTAN_TRUST_FORWARDED_FOR).toBe(false);
  });

  test("the relay holds no key", () => {
    expect(loadConfig("relay", parseEnv(join(ETC, "relay.env"))).RECEIPT_SIGNER).toBe("none");
  });

  test("every drop-in job runs under exactly one worker env", async () => {
    const lists = ["workers", "anchor", "receipts"].map((s) => ({
      s,
      jobs: (parseEnv(join(ETC, `${s}.env`)).WORKER_JOBS ?? "").split(",").map((j) => j.trim()).filter(Boolean),
    }));
    for (const l of lists) expect(l.jobs.length, `${l.s}.env WORKER_JOBS is an explicit list`).toBeGreaterThan(0);
    for (const job of await discoverJobs()) {
      const owners = lists.filter((l) => l.jobs.includes(job.name)).map((l) => l.s);
      expect(owners, `job ${job.name}`).toHaveLength(1);
    }
  });
});
