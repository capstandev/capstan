// Vite config for the Capstan website. The site is the owner's static multi-page design (web/*.html, with the
// owner's classic scripts, styles and media in web/public/); each page also loads one module entry under src/site/
// that wires the live views to the Capstan API through the SDK. The app imports the SDK and the receipts library
// straight from the workspace packages (../packages/*/src), so the dev server may read the repo root. No source maps
// ship (R10). After the build, scripts/hash-public.ts gives every public file a content-hashed name and rewrites the
// references, so every cached asset can be served immutable (vercel.json).
import react from "@vitejs/plugin-react";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every page: the owner's pages plus docs, verify, status, legal and 404. */
export const PAGES = readdirSync(here)
  .filter((f) => f.endsWith(".html"))
  .sort();

export default defineConfig({
  plugins: [react()],
  envPrefix: "VITE_",
  server: { host: "127.0.0.1", port: 22273, strictPort: true, fs: { allow: [repoRoot] } },
  preview: { host: "127.0.0.1", port: 22273, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    // the owner's public folder already has assets/; Vite's own hashed output goes next to it under _app/
    assetsDir: "_app",
    rollupOptions: { input: Object.fromEntries(PAGES.map((p) => [p.replace(/\.html$/, ""), `${here}${p}`])) },
  },
});
