#!/usr/bin/env bun
// Run a command with a timeout (cwip/node) so a clean step can't hang.
// Usage: bun scripts/withTimeout [ms] <command...>   e.g. withTimeout 3000 rm -rf dist
import { runWithTimeoutCli } from "cwip/node";

process.exit(await runWithTimeoutCli());
