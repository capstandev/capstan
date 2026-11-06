// The receipts library hashes with Node's Buffer; browsers have none. Imported first by main.tsx.
import { Buffer } from "buffer";

const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
