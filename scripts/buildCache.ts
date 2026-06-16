#!/usr/bin/env bun
// Incremental build cache (cwip/build): skips the UI build when its inputs are
// unchanged, and forces it when ui/dist is missing.
// Usage: bun scripts/buildCache <check|save|clean> [dir]
//   check ui  exit 0 = unchanged (skip), exit 1 = changed (build needed)
//   save  ui  record the manifest after a successful build
//   clean     drop the cache
import { DEFAULT_ROOT_INPUTS, runBuildCacheCli } from "cwip/build";

// The UI has its own lockfile, so bust the cache on a UI dependency change too
// (otherwise a deps-only change would skip the build AND the `bun install`).
process.exit(await runBuildCacheCli({ rootInputs: [...DEFAULT_ROOT_INPUTS, "ui/bun.lock"] }));
