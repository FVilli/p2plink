import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const p = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@p2plink\/core$/, replacement: p("../core/src/index.ts") },
      { find: /^@p2plink\/crypto$/, replacement: p("../crypto/src/index.ts") },
      { find: /^@p2plink\/mqtt$/, replacement: p("../mqtt/src/index.ts") },
      { find: /^@p2plink\/webrtc\/node$/, replacement: p("../webrtc/src/node.ts") },
      { find: /^@p2plink\/webrtc$/, replacement: p("../webrtc/src/index.ts") },
      { find: /^@p2plink\/client\/node$/, replacement: p("./src/node.ts") },
      { find: /^@p2plink\/client$/, replacement: p("./src/index.ts") },
      { find: /^@p2plink\/server$/, replacement: p("../server/src/index.ts") }
    ]
  },
  test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 60000 }
});
