import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const p = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@p2plink\/core$/, replacement: p("../../packages/core/src/index.ts") },
      { find: /^@p2plink\/crypto$/, replacement: p("../../packages/crypto/src/index.ts") },
      { find: /^@p2plink\/mqtt$/, replacement: p("../../packages/mqtt/src/index.ts") },
      { find: /^@p2plink\/webrtc$/, replacement: p("../../packages/webrtc/src/index.ts") },
      { find: /^@p2plink\/client$/, replacement: p("../../packages/client/src/index.ts") },
    ],
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { target: "es2022", sourcemap: true },
});
