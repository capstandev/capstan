// Postgres access: Drizzle over postgres.js 3.
import { db as schema } from "@capstan/schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

export function createDb(url: string, opts?: { max?: number }): Db {
  const client = postgres(url, { max: opts?.max ?? 10, onnotice: () => {} });
  return drizzle(client, { schema }) as Db;
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end({ timeout: 5 });
}

export { schema };
