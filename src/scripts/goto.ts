#!/usr/bin/env bun
/**
 * goto  (installed as a cd-kind shell function)
 *
 * Resolves a query (name / dir / repo / package name / alias) to an app and
 * prints a cd-able directory to stdout. For a file entry (e.g. ~/.zshrc) it
 * prints the containing dir. An unregistered query that is itself a real path
 * (e.g. `goto ./some/dir`) is accepted directly. The generated `goto` shell
 * function cd's into the printed path — which only works because it's a sourced
 * function, not a subprocess. Errors go to stderr so stdout stays a clean path.
 *
 * Usage (after rubato-setup):  goto myapp
 */

import { gotoTarget, resolveAppOrPath } from '../lib/apps';

async function main(): Promise<void> {
  const query = process.argv[2];
  if (!query) {
    console.error('usage: goto <name|alias|path>');
    process.exit(1);
  }
  const target = await resolveAppOrPath(query);
  console.log(await gotoTarget(target.absolutePath));
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
