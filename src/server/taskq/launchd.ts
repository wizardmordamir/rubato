/**
 * launchd plist for the taskq drainer's watchdog. A DISTINCT label
 * (`com.taskq.drain`) from the legacy drainer's, so the two can never be loaded
 * at once — the cutover is: unload the old label, load this one. The agent ticks
 * the drainer on an interval; an empty queue makes a tick a fast no-op, and the
 * drainer's own reaper handles crash recovery.
 */

export const TASKQ_LAUNCHD_LABEL = 'com.taskq.drain';

export interface TaskqLaunchdOptions {
  /** Absolute path to `bun`. */
  bunPath: string;
  /** Absolute path to the rubato checkout (where taskqDrain.ts lives). */
  rubatoDir: string;
  /** Tick interval in seconds (the drainer runs, drains, exits). */
  intervalSeconds: number;
  /** Where launchd writes stdout/stderr (under ~/.taskq by convention). */
  logDir: string;
  /** PATH for the agent (launchd's is minimal — must reach `bun` + `claude`). */
  path: string;
}

/** Render the launchd plist XML for the taskq watchdog. */
export function taskqLaunchdPlist(opts: TaskqLaunchdOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${TASKQ_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bunPath}</string>
    <string>run</string>
    <string>${opts.rubatoDir}/src/scripts/taskqDrain.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${opts.path}</string></dict>
  <key>StartInterval</key><integer>${opts.intervalSeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${opts.logDir}/watchdog.out</string>
  <key>StandardErrorPath</key><string>${opts.logDir}/watchdog.err</string>
</dict>
</plist>
`;
}

/**
 * launchd plist for the integration + promotion gate (the evolved main-health
 * watchdog). Keeps the LEGACY label `com.taskq.mainhealth` so the cutover from the
 * old untracked `~/.taskq/main-health-watchdog.ts` is a plain rewrite of the same
 * plist to point at the version-controlled `src/scripts/integrationGate.ts` — exactly
 * how `taskqDrain.ts` is the drainer's launchd entrypoint.
 */
export const INTEGRATION_GATE_LAUNCHD_LABEL = 'com.taskq.mainhealth';

export interface IntegrationGateLaunchdOptions {
  /** Absolute path to `bun`. */
  bunPath: string;
  /** Absolute path to the rubato checkout (where integrationGate.ts lives). */
  rubatoDir: string;
  /** Tick interval in seconds (the gate runs one cycle, then exits). */
  intervalSeconds: number;
  /** Where launchd writes stdout/stderr (under ~/.taskq by convention). */
  logDir: string;
  /** PATH for the agent (launchd's is minimal — must reach `bun`/`node`/`git`). */
  path: string;
  /** The agent's HOME (launchd's env omits it; the gate derives paths from it). */
  home: string;
}

/** Render the launchd plist XML for the integration + promotion gate. */
export function integrationGateLaunchdPlist(opts: IntegrationGateLaunchdOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${INTEGRATION_GATE_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bunPath}</string>
    <string>run</string>
    <string>${opts.rubatoDir}/src/scripts/integrationGate.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${opts.home}</string>
    <key>PATH</key><string>${opts.path}</string>
  </dict>
  <key>WorkingDirectory</key><string>${opts.logDir}</string>
  <key>StartInterval</key><integer>${opts.intervalSeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${opts.logDir}/mainhealth.out</string>
  <key>StandardErrorPath</key><string>${opts.logDir}/mainhealth.err</string>
</dict>
</plist>
`;
}
