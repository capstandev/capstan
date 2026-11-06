// Lossless JSON for venue responses (audit lesson IDS-1): integers outside the safe range (above 2^53 - 1) are kept
// as strings instead of being rounded by JSON.parse. Everything else parses as usual.
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function parseJsonLossless(text: string): unknown {
  let out = "";
  let i = 0;
  let changed = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      // copy the string literal verbatim
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < n && /[0-9eE.+-]/.test(text[j]!)) j++;
      const tok = text.slice(i, j);
      if (/^-?\d{16,}$/.test(tok)) {
        const b = BigInt(tok);
        if (b > SAFE || b < -SAFE) {
          out += `"${tok}"`;
          changed = true;
          i = j;
          continue;
        }
      }
      out += tok;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(changed ? out : text);
}
