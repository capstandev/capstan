// `bun run openapi`: writes apps/api/openapi.json from the mounted routes (sorted, stable output).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRoutes } from "../app";
import { generateOpenApi } from "./index";

export const OPENAPI_FILE = join(import.meta.dir, "../../openapi.json");

export async function openApiText(): Promise<string> {
  const specs = (await discoverRoutes()).map((r) => r.spec);
  return `${JSON.stringify(generateOpenApi(specs), null, 2)}\n`;
}

if (import.meta.main) {
  writeFileSync(OPENAPI_FILE, await openApiText());
  console.log(`openapi: wrote ${OPENAPI_FILE}`);
}
