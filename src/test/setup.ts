/**
 * Global test preload (wired in `bunfig.toml` → `[test] preload`). Runs once
 * before any test module loads.
 *
 * Its whole job is **protecting real user state**: `RUBATO_HOME` is resolved at
 * import time in `src/lib/config.ts`, and `loadConfig()` will *create*
 * `config.json` in `~/.rubato` if it's missing — so without this, `bun test`
 * could read and even write your actual registry. We point `RUBATO_HOME` (and the
 * Claude config dir some routes touch) at throwaway temp dirs before anything
 * reads them. Tests/subprocesses that pin their own value still win — we only set
 * a default when one isn't already present.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

function isolate(envVar: string, prefix: string): void {
  if (process.env[envVar]) return;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env[envVar] = dir;
  created.push(dir);
}

isolate('RUBATO_HOME', 'rubato-test-home-');
isolate('CLAUDE_CONFIG_DIR', 'rubato-test-claude-');

// Never let a test auto-spawn a real taskq drain subprocess: the config route's
// "kick the drainer after a settings change" reads GLOBAL machine state
// (launchctl/pgrep) and would otherwise fire against the real watchdog/queue.
process.env.TASKQ_NO_AUTOKICK ??= '1';

// Best-effort cleanup of the temp dirs we created.
process.on('exit', () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // already gone / in use — fine, it's a temp dir.
    }
  }
});
