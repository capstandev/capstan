// Each catalog test file runs on its own migrated throwaway database (needs DATABASE_URL; skips without it).
import { closeDb, createDb, createTempDatabase, type Db } from "@capstan/core";
import { describe } from "bun:test";

export const BASE = process.env.DATABASE_URL;
export const dbDescribe = BASE ? describe : describe.skip;

export async function freshDb(): Promise<{ db: Db; drop(): Promise<void> }> {
  const t = await createTempDatabase(BASE!, { migrated: true, prefix: "capstan_cat" });
  const db = createDb(t.url, { max: 4 });
  return {
    db,
    async drop() {
      await closeDb(db);
      await t.drop();
    },
  };
}
