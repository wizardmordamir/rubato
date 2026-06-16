import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// Library build of rubato's reusable UI surface, consumed by "friend" apps via the
// `rubato/ui/shell` + `rubato/ui/automations` package exports (plugin-system Stage
// 4). Separate from vite.config.ts (the app/SPA build) so the app build is
// untouched. Two entries → ui/dist-lib/shell.js + ui/dist-lib/automations.js.
//
// Externalised: the context-bearing singletons (react, react-dom, react-router-dom,
// @tanstack/*) AND cwip — friend apps install these themselves, and bundling them
// would risk duplicate React/cwip-store instances (two toast stores, a null hook
// dispatcher → white screen). Everything else (recharts, glide-data-grid,
// react-markdown, yaml, rubato's own `@shared/*` types) is bundled in.
const EXTERNAL = [/^react($|\/)/, /^react-dom($|\/)/, "react-router-dom", /^@tanstack\//, /^cwip($|\/)/];

export default defineConfig({
  plugins: [react()],
  // `@shared` stays an alias so it resolves (and bundles) within rubato's own build,
  // exactly as in vite.config.ts — friend apps don't need to re-map it for the JS.
  resolve: {
    alias: { "@shared": resolve(here, "../src/shared") },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "@tanstack/react-query"],
  },
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    // Keep readable, debuggable output for an embeddable library.
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        shell: resolve(here, "src/shell/index.ts"),
        automations: resolve(here, "src/pages/Automations/index.ts"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: EXTERNAL,
      output: {
        // Share common code (cwip-free app internals) across the two entries via a
        // chunk dir instead of duplicating it into each bundle.
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
