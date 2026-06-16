import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

/**
 * The run store + db read RUBATO_HOME at import time, so isolating them means a
 * fresh process with the env set. We run the whole latest-run/archive/file cycle
 * in a child `bun -e` against a throwaway home and assert it prints OK.
 */
describe('runStore + db (isolated home)', () => {
  test('upserts latest per command, archives, writes the output file', async () => {
    const root = resolve(import.meta.dir, '../..');
    const home = resolve('/tmp', `rubato-test-store-${process.pid}`);
    const code = `
      import { recordRun, listRuns, archiveRun, listArchives, deleteArchive } from "./src/server/db.ts";
      import { writeLatestOutput, ensureOutputDir, resolveOutputDir } from "./src/lib/runStore.ts";
      import { stat } from "node:fs/promises";
      import { strict as assert } from "node:assert";

      const base = { args: [], exitCode: 0, output: "first", startedAt: 1, durationMs: 5 };
      recordRun({ command: "demo", ...base });
      recordRun({ command: "demo", ...base, output: "second", startedAt: 2 }); // same command → replace

      const runs = listRuns();
      assert.equal(runs.filter((r) => r.command === "demo").length, 1, "one row per command");
      assert.equal(runs.find((r) => r.command === "demo").output, "second", "latest wins");

      const a = archiveRun("demo");
      assert.ok(a && a.archivedAt > 0, "archive created");
      assert.equal(a.output, "second");
      assert.equal(listArchives().length, 1);
      assert.equal(deleteArchive(a.id), true);
      assert.equal(listArchives().length, 0);
      assert.equal(archiveRun("missing"), null, "no run → null");

      const p = await writeLatestOutput("demo", ["x"], 0, "hello", 1700000000000);
      assert.ok(p.endsWith("/outputs/demo.txt"), "path under outputs");
      const text = await Bun.file(p).text();
      assert.ok(text.startsWith("# demo x — exit 0"), "file leads with header");
      assert.ok(text.includes("hello"), "file holds output");

      // ensureOutputDir returns the output dir and creates it on disk.
      const dir = await ensureOutputDir();
      assert.equal(dir, await resolveOutputDir(), "ensureOutputDir returns the output dir");
      assert.ok((await stat(dir)).isDirectory(), "output dir exists after ensureOutputDir");

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
