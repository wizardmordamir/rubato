import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// Library build of rubato's reusable UI surface, consumed by "friend" apps via the
// `rubato/ui/shell` + `rubato/ui/automations` + `rubato/ui/excel` +
// `rubato/ui/board` + `rubato/ui/links` + `rubato/ui/vault` package exports
// (plugin-system Stage 4–7). Separate from vite.config.ts (the app/SPA build) so
// the app build is untouched.
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
    // Consume cursedbelt as SOURCE (its `source` export condition -> ./src), exactly
    // like the SPA build (vite.config.ts) and tsc (tsconfig.lib.json inherits
    // customConditions:["source"]). Without this the lib build falls back to
    // cursedbelt's published `dist`, which can be stale relative to the integration
    // source it's symlinked to — re-exporting names its current source no longer
    // exports (e.g. CodeCell/getCellRenderer/LinkCell from DataTable) ⇒ MISSING_EXPORT
    // build failures. Resolving source keeps the lib build in lockstep with the
    // symlinked first-party source, no cursedbelt rebuild needed.
    conditions: ["source", "import", "module", "browser", "default"],
    // recharts + glide-data-grid are cursedbelt OPTIONAL peers; without deduping them
    // to ru-ui's installed copy, rolldown resolves cursedbelt's imports to the
    // `__vite-optional-peer-dep` stub and the bundle fails (e.g. "DataEditor is not
    // exported" from cursedbelt/react/spreadsheet). Dedupe so they bundle for real.
    dedupe: ["react", "react-dom", "react/jsx-runtime", "@tanstack/react-query", "recharts", "@glideapps/glide-data-grid"],
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
        "automations-components": resolve(here, "src/pages/Automations/components.ts"),
        excel: resolve(here, "src/pages/Excel/index.ts"),
        board: resolve(here, "src/pages/Board/index.ts"),
        links: resolve(here, "src/pages/Links/index.ts"),
        vault: resolve(here, "src/pages/Vault/index.ts"),
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
