#!/usr/bin/env bun
/**
 * scan-apps  (installed as `rubato-scan`)
 *
 * Recursively finds git repos under your codeDirs (~/code by default — set one
 * or more roots in ~/.rubato/config.json) and merges them into
 * ~/.rubato/apps.json. Derived fields (absolutePath, dirName, group,
 * repoName, packageJsonName) are refreshed on every scan; user-owned fields
 * (name, aliases, and any API metadata like gitlab/quay/rancher) are preserved.
 *
 * Linked git worktrees and submodules (where `.git` is a file, not a directory)
 * are skipped, as are `*-worktrees/` and `*-integration` directories — transient
 * feature checkouts and integration worktree siblings shouldn't pollute the registry
 * with duplicates of a repo indexed elsewhere.
 *
 * Apps that have disappeared from disk are flagged `"missing": true` if you've
 * customized them (title/aliases/metadata), or dropped if they were purely
 * scan-derived — so your edits survive a move while stale entries clean up.
 *
 * An entry with `"pinned": true` is frozen: scan never refreshes its derived
 * fields, takes it over as managed, or flags it missing — handy for a repo you
 * want to keep hand-tuned, or any path you want immune to scans.
 *
 * Usage:
 *   bun run src/scripts/scan-apps.ts            # scan + merge
 *   bun run src/scripts/scan-apps.ts --dry-run  # report without writing
 */

import type { Conflict } from '../lib/apps';
import { APPS_FILE, loadConfig } from '../lib/config';
import { runScan } from '../lib/scanApps';

function formatConflict(c: Conflict): string[] {
  if (c.kind === 'match-key') {
    const w = Math.max(...c.apps.map((a) => a.name.length));
    const rows = c.apps.map((a) => {
      const src = a.sources?.[0];
      const detail = src ? `${src.label}  →  ${src.path}` : a.path;
      return `      ${a.name.padEnd(w)}   ${detail}`;
    });
    return [
      `  • Match key "${c.key}" claimed by ${c.apps.length} apps:`,
      ...rows,
      '    Fix: rename one, clear the clashing field, or move it to an alias.',
    ];
  }
  if (c.kind === 'duplicate-name') {
    return [
      `  • Duplicate name "${c.key}" — ${c.apps.length} apps share it:`,
      ...c.apps.map((a) => `      ${a.path}`),
      `    Fix: rename one in ${APPS_FILE}.`,
    ];
  }
  return [
    `  • Duplicate path — ${c.apps.length} entries point at ${c.key}:`,
    ...c.apps.map((a) => `      ${a.name}`),
    `    Fix: remove the duplicate entry in ${APPS_FILE}.`,
  ];
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = await loadConfig();
  console.log(`Scanning ${cfg.codeDirs.join(', ')} ...`);

  const result = await runScan({ roots: cfg.codeDirs, ignore: cfg.ignore, dryRun });
  const { reposFound, newApps, updatedCount, pinnedCount, missingApps, removedCount, conflicts } = result;

  console.log(
    `Found ${reposFound} repos — ${newApps.length} new, ${updatedCount} updated` +
      (pinnedCount ? `, ${pinnedCount} pinned (skipped)` : '') +
      (missingApps.length ? `, ${missingApps.length} missing` : '') +
      (removedCount ? `, ${removedCount} removed` : ''),
  );

  if (newApps.length) {
    console.log(`\n🆕 New (${newApps.length}):`);
    for (const a of newApps) console.log(`      ${a.name}   ${a.absolutePath}`);
  }
  if (missingApps.length) {
    console.log(`\n👻 Missing — kept (you've customized these), but gone from disk:`);
    for (const a of missingApps) console.log(`      ${a.name}   ${a.absolutePath}`);
  }
  if (conflicts.length) {
    console.warn(`\n⚠️  ${conflicts.length} registry conflict(s) to resolve in ${APPS_FILE}:`);
    conflicts.forEach((c, i) => {
      if (i) console.warn('');
      for (const line of formatConflict(c)) console.warn(line);
    });
  }

  if (dryRun) {
    console.log('\n🔎 Dry run — apps.json not written.');
    return;
  }

  console.log(`\n✅ Wrote apps to ${APPS_FILE}`);
  if (newApps.length) {
    console.log('   Add aliases to new entries, then use: goto <alias>  /  gotab <alias>');
  }
}

if (import.meta.main)
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
