// Key-like value scan for the MCP and npm proof (ops/mcp-proof/run.sh). Plain Node, no dependencies.
// A finding is: a JSON field named like a key (private key, secret, seed, mnemonic, password, passphrase), a PEM
// block, a Capstan API key (cpst_...), a raw 32-byte hex value under a field that is not a hash, id, root, signature
// or address-like name, or any canary value the stack was started with (PROOF_CANARIES, comma list).
// CLI: node keyscan.mjs <file>...  (exit 1 on any finding)
import { readFileSync } from "node:fs";

const KEY_FIELD = /(private.?key|secret|seed|mnemonic|password|passphrase|keystore)/i;
const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
// field names a 32-byte hex value may sit under: hashes, ids, roots, digests, signatures and their parts, tx data
const HEX_OK_FIELD = /(hash|root|digest|id|sha|leaf|proof|sig|signature|^r$|^s$|tx|topic|nonce|salt|template|domain|payload|message|data|commitment|key ?hash|^receiptHint$)/i; // receiptHint: sha256 of the quote (packages/quote)
const canaries = () => (process.env.PROOF_CANARIES ?? "").split(",").map((s) => s.trim()).filter((s) => s.length >= 16);

export function scanText(text, label) {
  const out = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) out.push(`${label}: PEM private key block`);
  const api = text.match(/cpst_[A-Za-z0-9_-]{10,}/g);
  if (api) out.push(`${label}: API key shaped value ${api[0].slice(0, 9)}...`);
  for (const c of canaries()) if (text.includes(c)) out.push(`${label}: a stack canary value appears`);
  return out;
}

export function scanJson(value, label, path = []) {
  const out = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...p, String(i)])); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        // a schema property or description that names a key is fine; a field holding a value under such a name is not
        const inSchema = p.includes("inputSchema") || p.includes("outputSchema") || p.includes("properties");
        if (KEY_FIELD.test(k) && !inSchema && x !== null && x !== undefined && x !== "" && typeof x !== "boolean") out.push(`${label}: field ${[...p, k].join(".")} is named like a key`);
        walk(x, [...p, k]);
      }
      return;
    }
    if (typeof v === "string") {
      const last = p.filter((s) => !/^\d+$/.test(s)).at(-1) ?? "";
      if (HEX32.test(v) && !HEX_OK_FIELD.test(last)) out.push(`${label}: 32-byte hex value under ${p.join(".")}`);
      // JSON inside text content: scan it as JSON too
      if ((v.startsWith("{") || v.startsWith("[")) && v.length < 2_000_000) { try { out.push(...scanJson(JSON.parse(v), label, [...p, "(json)"])); } catch { /* plain text */ } }
    }
  };
  walk(value, path);
  return out;
}

export function scanAll(text, label) {
  const out = scanText(text, label);
  try { out.push(...scanJson(JSON.parse(text), label)); } catch {
    for (const line of text.split("\n")) { const l = line.replace(/^data:\s*/, ""); if (l.startsWith("{")) { try { out.push(...scanJson(JSON.parse(l), label)); } catch { /* not JSON */ } } }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("keyscan.mjs")) {
  const found = [];
  for (const f of process.argv.slice(2)) found.push(...scanAll(readFileSync(f, "utf8"), f.split("/").at(-1)));
  if (found.length) { for (const x of found.slice(0, 20)) console.error(x); process.exit(1); }
  console.log(`keyscan: ${process.argv.length - 2} files, no key-like value`);
}
