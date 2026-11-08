// Serves a built site the way vercel.json has the host serve it: clean URLs (/docs is docs.html), 404.html with a
// 404 for anything else, assets/ and _app/ immutable. Loopback only. Used by ops/fork/up.sh (FORK_WEB=dist) and the
// site browser pass. Usage: bun scripts/serve-dist.ts --dir <dist> --port <port>
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain" };

export function resolveRequest(dir: string, pathname: string): { file: string; status: number } {
  const path = decodeURIComponent(pathname);
  let p = join(dir, path === "/" ? "index.html" : path);
  if (p.startsWith(dir) && !extname(p) && existsSync(`${p}.html`)) p = `${p}.html`;
  if (!p.startsWith(dir) || !existsSync(p) || statSync(p).isDirectory()) return { file: join(dir, "404.html"), status: 404 };
  return { file: p, status: 200 };
}

if (import.meta.main) {
  const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
  const dir = resolve(arg("--dir") ?? "dist");
  const port = Number(arg("--port") ?? 24143);
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const { file, status } = resolveRequest(dir, new URL(req.url).pathname);
      const cache = /\/(assets|_app)\//.test(file) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
      return new Response(readFileSync(file), { status, headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache } });
    },
  });
  console.log(`serve-dist: ${dir} on http://127.0.0.1:${port}`);
}
