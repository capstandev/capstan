// Throwaway migrated database per test file (skips without DATABASE_URL).
import { closeDb, createDb, createTempDatabase, type Db } from "@capstan/core";

export const PG = process.env.DATABASE_URL;
export const REDIS = process.env.REDIS_URL;
export const HOOK_MS = 60_000;

export async function tempDb(prefix: string): Promise<{ db: Db; drop(): Promise<void> }> {
  const t = await createTempDatabase(PG!, { migrated: true, prefix });
  const db = createDb(t.url, { max: 4 });
  return {
    db,
    async drop() {
      await closeDb(db);
      await t.drop();
    },
  };
}
