// Vite config for the Capstan site and dashboard. The app imports the SDK and the receipts library straight from the
// workspace packages (../packages/*/src), so the dev server may read the repo root. No source maps ship (R10).
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  envPrefix: "VITE_",
  server: { host: "127.0.0.1", port: 22273, strictPort: true, fs: { allow: [repoRoot] } },
  preview: { host: "127.0.0.1", port: 22273, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000 },
});
