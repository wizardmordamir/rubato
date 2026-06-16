import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

/**
 * Backups read RUBATO_HOME at import time, so the full create → inspect → restore
 * cycle runs in a child `bun -e` against a throwaway home. This exercises the real
 * bun:sqlite paths: VACUUM INTO snapshot, read-only open, and ATTACH-based restore.
 */
describe('admin backups (isolated home)', () => {
  test('create, list, inspect, and restore a table over the live DB', async () => {
    const root = resolve(import.meta.dir, '../../..');
    const home = resolve('/tmp', `rubato-test-backups-${process.pid}`);
    const code = `
      import { recordRun, listRuns, getDb } from "./src/server/db.ts";
      import { createBackup, listBackups, backupTables, queryBackupTable, restoreBackup } from "./src/server/admin/backups.ts";
      import { strict as assert } from "node:assert";

      // Seed the live DB with one run.
      recordRun({ command: "demo", args: [], exitCode: 0, output: "hi", startedAt: 1, durationMs: 5 });
      assert.equal(listRuns().filter((r) => r.command === "demo").length, 1);

      // Snapshot it.
      const b = await createBackup();
      assert.ok(b.fileName.endsWith(".sqlite"), "backup is a .sqlite file");
      assert.ok(b.size > 0, "backup has bytes");

      const all = await listBackups();
      assert.ok(all.some((x) => x.fileName === b.fileName), "backup is listed");

      // Inspect the backup read-only.
      const tables = backupTables(b.fileName);
      const runsTable = tables.find((t) => t.name === "runs");
      assert.ok(runsTable && runsTable.rowCount >= 1, "backup has the runs table with rows");

      const q = queryBackupTable(b.fileName, "runs", { filters: [{ column: "command", op: "eq", value: "demo" }] });
      assert.equal(q.total, 1, "backup query finds the demo run");

      // Mutate the live DB, then restore from the backup.
      getDb().run("DELETE FROM runs");
      assert.equal(listRuns().length, 0, "live runs cleared");

      const result = await restoreBackup(b.fileName, ["runs", "nope_missing"]);
      assert.ok(result.safetyBackup.startsWith("pre-restore-"), "safety snapshot taken");
      const restoredRuns = result.restored.find((r) => r.table === "runs");
      assert.ok(restoredRuns && restoredRuns.rowsCopied >= 1, "runs restored");
      assert.ok(result.skipped.some((s) => s.table === "nope_missing"), "unknown table skipped");
      assert.equal(listRuns().filter((r) => r.command === "demo").length, 1, "demo run is back");

      // The safety snapshot also shows up in the list, flagged.
      const after = await listBackups();
      assert.ok(after.some((x) => x.fileName === result.safetyBackup && x.safety === true), "safety flagged");

      console.log("OK");
    `;
    const proc = Bun.spawn(['bun', '-e', code], {
      cwd: root,
      env: { ...process.env, RUBATO_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err + out).toContain('OK');
    expect(exitCode).toBe(0);
  });
});
