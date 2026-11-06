// Test helpers for packages that need a real database: a throwaway database per test file, migrated or not.
import postgres from "postgres";
import { migrate } from "./migrate";

export const TEST_DATABASE_URL = process.env.DATABASE_URL;
export const TEST_REDIS_URL = process.env.REDIS_URL;

/** Create a fresh database next to the one in `baseUrl`; drop() removes it. */
export async function createTempDatabase(baseUrl: string, opts?: { migrated?: boolean; prefix?: string }): Promise<{ url: string; name: string; drop(): Promise<void> }> {
  const name = `${opts?.prefix ?? "capstan_t"}_${process.pid}_${Math.floor(performance.now() * 1000).toString(36)}`.toLowerCase();
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end({ timeout: 5 });
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  if (opts?.migrated) await migrate(url);
  return {
    url,
    name,
    async drop() {
      const a = postgres(baseUrl, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await a.end({ timeout: 5 });
    },
  };
}
