import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

/**
 * command_stats drives the Commands page run-based sorts. db reads RUBATO_HOME at
 * import time, so (like runStore.test) we exercise the upsert/read/cleanup cycle in
 * a child `bun -e` against a throwaway home and assert it prints OK.
 */
describe('command_stats (isolated home)', () => {
  test('bumps run count + last run, separates scopes, and cleans up on delete', async () => {
    const root = resolve(import.meta.dir, '../..');
    const home = resolve('/tmp', `rubato-test-cmdstats-${process.pid}`);
    const code = `
      import { bumpCommandStat, getCommandStats, saveSavedCommand, deleteSavedCommand } from "./src/server/db.ts";
      import { strict as assert } from "node:assert";

      // builtin scope: two runs accumulate; last run + exit win.
      bumpCommandStat("builtin", "deploy", 0, 1000);
      bumpCommandStat("builtin", "deploy", 1, 2000);
      const deploy = getCommandStats().find((s) => s.scope === "builtin" && s.key === "deploy");
      assert.ok(deploy, "deploy stat exists");
      assert.equal(deploy.runCount, 2, "two runs counted");
      assert.equal(deploy.lastRunAt, 2000, "latest run wins");
      assert.equal(deploy.lastExitCode, 1, "latest exit code wins");

      // saved scope is separate even with a key that overlaps a builtin name.
      bumpCommandStat("saved", "deploy", 0, 500);
      const savedDeploy = getCommandStats().find((s) => s.scope === "saved" && s.key === "deploy");
      assert.equal(savedDeploy.runCount, 1, "saved scope counted independently");

      // deleting a saved command drops its stats too.
      const sc = saveSavedCommand({ name: "demo", kind: "shell", command: "echo hi" });
      bumpCommandStat("saved", sc.id, 0, 1);
      assert.ok(getCommandStats().some((s) => s.scope === "saved" && s.key === sc.id), "saved stat present");
      assert.equal(deleteSavedCommand(sc.id), true, "saved command deleted");
      assert.ok(!getCommandStats().some((s) => s.scope === "saved" && s.key === sc.id), "saved stat cleaned up");

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
