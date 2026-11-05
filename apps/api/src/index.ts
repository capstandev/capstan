// @capstan/api entry. `bun run apps/api/src/index.ts` serves on API_PORT (default 8710).
import { app } from "./app";

export { app };

if (import.meta.main) {
  const port = Number(process.env.API_PORT ?? 8710);
  Bun.serve({ port, fetch: app.fetch });
  console.log(`api listening on :${port}`);
}
