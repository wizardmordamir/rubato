import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

/**
 * files.ts reads the output dir, which is derived from RUBATO_HOME at import time,
 * so (like the run store) we exercise it in a child `bun -e` against a throwaway
 * home: write a few files, then assert listing + guarded reads behave.
 */
describe('output files (isolated home)', () => {
  test('lists files, reads one, refuses traversal + secrets', async () => {
    const root = resolve(import.meta.dir, '../..');
    const home = resolve('/tmp', `rubato-test-files-${process.pid}`);
    const code = `
      import { listOutputFiles, readOutputFile } from "./src/server/files.ts";
      import { resolveOutputDir } from "./src/lib/runStore.ts";
      import { mkdir } from "node:fs/promises";
      import { resolve } from "node:path";
      import { strict as assert } from "node:assert";

      const dir = await resolveOutputDir();
      await mkdir(resolve(dir, "sub"), { recursive: true });
      await Bun.write(resolve(dir, "shalist.txt"), "line one\\nline two\\n");
      await Bun.write(resolve(dir, "sub", "report.json"), '{"ok":true}');
      await Bun.write(resolve(dir, ".env"), "SECRET=should-never-list");

      const files = await listOutputFiles();
      const paths = files.map((f) => f.path).sort();
      assert.deepEqual(paths, ["shalist.txt", "sub/report.json"], "lists files, skips dotfiles: " + JSON.stringify(paths));
      assert.ok(files.every((f) => typeof f.size === "number" && f.modifiedAt > 0), "has size + mtime");

      const rel = await readOutputFile("shalist.txt");
      assert.ok(rel.ok && rel.content.includes("line two"), "reads a relative path");

      const abs = await readOutputFile(resolve(dir, "sub", "report.json"));
      assert.ok(abs.ok && abs.content.includes("ok"), "reads an absolute path inside the dir");

      const up = await readOutputFile("../config.json");
      assert.ok(!up.ok && up.status === 403, "refuses traversal");

      const secret = await readOutputFile(".env");
      assert.ok(!secret.ok && secret.status === 403, "refuses a secret file");

      const missing = await readOutputFile("nope.txt");
      assert.ok(!missing.ok && missing.status === 404, "404s a missing file");

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
