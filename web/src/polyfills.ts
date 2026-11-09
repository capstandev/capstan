// The receipts library hashes with Node's Buffer; browsers have none. Imported first by main.tsx.
import { Buffer } from "buffer";

const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;

// zod 4 probes for `new Function` support the first time a schema parses. The site's CSP (script-src 'self', no
// 'unsafe-eval') refuses it and the browser logs a violation even though zod catches the throw. jitless skips the
// probe and zod parses without generated code. zod keeps its config on globalThis, so this reaches every copy.
const z = globalThis as { __zod_globalConfig?: Record<string, unknown> };
z.__zod_globalConfig = Object.assign(z.__zod_globalConfig ?? {}, { jitless: true });
