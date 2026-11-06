// drizzle-kit config: `bun run db:generate` writes SQL migrations from packages/schema/src/db.ts.
// Timescale DDL (hypertables, retention, continuous aggregates) is a custom migration: `bunx drizzle-kit generate --custom --name <n>`.
// Every migration also needs a hand-written down file in packages/core/migrations/down/<tag>.sql (migrate.test.ts checks).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/schema/src/db.ts",
  out: "./packages/core/migrations",
});
