#!/usr/bin/env bun
/**
 * build — produce the published, minified `dist/`.
 *
 * rubato normally runs from raw `.ts` (no build step). This script is ONLY for
 * publishing: it bundles + minifies the whole surface into a flat `dist/` so the
 * package ships compact, hard-to-casually-reuse JS instead of source — and ships
 * no docs. Consumers still need Bun (the code uses `Bun.*`, `bun:sqlite`, etc.).
 *
 * What it emits:
 *   - dist/<name>.js          one minified bundle per package.json "exports"
 *                             entry (the library surface, incl. `on()`)
 *   - dist/scripts/<name>.js  one per registered command + the CLI umbrella /
 *                             capture wrapper, so `rubato`, `rubato-serve`, the
 *                             web "Run" button, etc. still work from the package
 *   - dist/browser-host.mjs   the Node Playwright host, minified (run via `node`)
 *
 * npm deps stay external (resolved from node_modules at install time). No types
 * are emitted — that's intentional (see CLAUDE.md / the publish decision).
 *
 *   bun run scripts/build.ts
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { COMMANDS } from "../src/commands";
// outName → source for every published library entry — single source of truth,
// shared with the package.json "exports" drift check + the import-hygiene test.
import { LIB_ENTRIES } from "./libEntries";

const ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(ROOT, "dist");
const SHIM_DIR = resolve(ROOT, ".build-tmp");


/** Fail if package.json "exports" no longer matches the entries we bundle. */
async function assertExportsInSync(): Promise<void> {
  const pkg = await Bun.file(resolve(ROOT, "package.json")).json();
  const expected = new Set(
    Object.keys(LIB_ENTRIES).map((n) => (n === "index" ? "." : `./${n}`)),
  );
  // `./ui/*` entries are produced by the separate Vite lib build (ui/dist-lib),
  // not by LIB_ENTRIES/this dist build; `*.css` entries are static shipped
  // stylesheets (e.g. `./styles.css`) — both are outside this JS-entry drift check.
  const actual = new Set(
    Object.keys(pkg.exports).filter(
      (k) => k !== "./package.json" && !k.startsWith("./ui/") && !k.endsWith(".css"),
    ),
  );
  const missing = [...expected].filter((k) => !actual.has(k));
  const extra = [...actual].filter((k) => !expected.has(k));
  if (missing.length || extra.length) {
    throw new Error(
      `package.json "exports" out of sync with build — missing: [${missing}], extra: [${extra}]. ` +
        `Update LIB_ENTRIES in scripts/build.ts and the exports map together.`,
    );
  }
}

/** Fail loudly with the bundler's own diagnostics. */
function assertBuilt(result: { success: boolean; logs: unknown[] }, label: string): void {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed: ${label}`);
  }
}

async function main() {
  await assertExportsInSync();
  await rm(DIST, { recursive: true, force: true });
  await rm(SHIM_DIR, { recursive: true, force: true });
  await mkdir(SHIM_DIR, { recursive: true });

  // ── Library bundles (the importable surface, incl. on()) ───────────────────
  // Each "exports" entry needs a uniquely-named output, but the real sources are
  // mostly `index.ts` (collision). Re-export each through a uniquely-named shim,
  // then bundle the shims so output names are the export keys.
  const lib = Object.fromEntries(
    Object.entries(LIB_ENTRIES).map(([name, src]) => [name, resolve(ROOT, src)]),
  );
  const shimPaths: string[] = [];
  for (const [name, src] of Object.entries(lib)) {
    // A slashed entry name (e.g. `plugins/automations`) maps to a nested export
    // KEY but a flat dist FILE — flatten `/`→`__` for the shim/output basename so
    // it lands at `dist/plugins__automations.js` (package.json points the
    // `./plugins/automations` export there). It stays in this same splitting
    // build, so it shares chunks (one `getDb`, etc.) with the `server` entry.
    const shim = resolve(SHIM_DIR, `${name.replace(/\//g, "__")}.ts`);
    await writeFile(shim, `export * from ${JSON.stringify(src)};\n`);
    shimPaths.push(shim);
  }
  assertBuilt(
    await Bun.build({
      entrypoints: shimPaths,
      outdir: DIST,
      target: "bun",
      minify: true,
      splitting: true,
      packages: "external",
      naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    }),
    "library",
  );

  // ── Command scripts (so the CLI + web "Run" still work from the package) ────
  const scriptSources = new Set<string>([
    ...COMMANDS.map((c) => resolve(ROOT, c.script)),
    resolve(ROOT, "src/index.ts"), // `rubato` umbrella
    resolve(ROOT, "src/scripts/run-capture.ts"), // capture wrapper
  ]);
  assertBuilt(
    await Bun.build({
      entrypoints: [...scriptSources],
      outdir: resolve(DIST, "scripts"),
      target: "bun",
      minify: true,
      splitting: true,
      packages: "external",
      naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    }),
    "scripts",
  );

  // The published `bin` is invoked directly (npm symlink), so it needs a real
  // shebang as line 1. Other scripts are always spawned via `bun run` and don't.
  // (Bun's `banner` lands after its `// @bun` marker — line 3 — which is a syntax
  // error, so prepend by hand.)
  const bin = resolve(DIST, "scripts", "setup-aliases.js");
  await writeFile(bin, `#!/usr/bin/env bun\n${await Bun.file(bin).text()}`);
  await chmod(bin, 0o755);

  // ── Node Playwright host (run via `node`, not bun) ─────────────────────────
  const host = resolve(ROOT, "src/scripts/browser-host.mjs");
  if (existsSync(host)) {
    assertBuilt(
      await Bun.build({
        entrypoints: [host],
        outdir: DIST,
        target: "node",
        minify: true,
        packages: "external",
        naming: { entry: "[name].mjs", chunk: "chunk-[hash].mjs" },
      }),
      "browser-host",
    );
  }

  await rm(SHIM_DIR, { recursive: true, force: true });

  const libCount = Object.keys(lib).length;
  const scriptCount = scriptSources.size;
  console.log(`✅ dist/ built — ${libCount} library bundles, ${scriptCount} scripts, browser-host.mjs`);
  console.log("   Next: bun run web:build (UI), then npm publish (or npm pack --dry-run to inspect).");
}

main().catch((err) => {
  console.error("❌ build failed:", err instanceof Error ? err.message : err);
  // Bun.build rejects with an AggregateError; surface the per-message details.
  if (err && typeof err === "object" && "errors" in err && Array.isArray((err as AggregateError).errors)) {
    for (const e of (err as AggregateError).errors) console.error(e);
  }
  process.exit(1);
});
