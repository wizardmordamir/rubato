/**
 * The published-entry source map: outName → source file. Single source of truth
 * for `scripts/build.ts` (what it bundles into `dist/<name>.js`), the package.json
 * `exports` drift check, and the library-import-hygiene guard test
 * (`src/test/libImports.test.ts`). Kept as data-only (no side effects) so any of
 * those can import it freely.
 *
 * `package.json` "exports" points at the built `dist/<name>.js`, so it can't also
 * name the source — this map is where the source lives.
 */
export const LIB_ENTRIES: Record<string, string> = {
  index: "src/lib.ts", // exports "."
  api: "src/api/index.ts",
  jenkins: "src/api/jenkins/index.ts",
  quay: "src/api/quay/index.ts",
  gitlab: "src/api/gitlab/index.ts",
  splunk: "src/api/splunk/index.ts",
  datadog: "src/api/datadog/index.ts",
  dynatrace: "src/api/dynatrace/index.ts",
  github: "src/api/github/index.ts",
  rancher: "src/api/rancher/index.ts",
  openshift: "src/api/openshift/index.ts",
  harness: "src/api/harness/index.ts",
  deploy: "src/lib/deploy/index.ts",
  git: "src/lib/git.ts",
  apps: "src/lib/apps.ts",
  config: "src/lib/config.ts",
  output: "src/lib/output.ts",
  automation: "src/lib/automation/index.ts",
  tools: "src/shared/tools/index.ts",
  request: "src/shared/request/index.ts",
  orchestration: "src/lib/orchestration/index.ts",
  // The embeddable server + web UI (`on()`) — the ONE entry that intentionally
  // pulls in the server/db/UI; kept out of the library barrel so importing
  // `rubato` (or any other library subpath) stays server/UI/Playwright-free.
  server: "src/on.ts",
  // Plugin modules — friend mini-apps assemble them via
  // `import { automationsPlugin } from 'rubato/plugins/automations'` etc. All are
  // server-coupled (wrap route handlers + DDL), so like `server` they're exempt from
  // the "no server import" library-hygiene guard. Slash names map to `./plugins/*`
  // export keys; the built bundles flatten the slash to `__` in the dist filename.
  "plugins/automations": "src/plugins/automations.ts",
  "plugins/excel": "src/plugins/excel.ts",
  "plugins/board": "src/plugins/board.ts",
  "plugins/links": "src/plugins/links.ts",
  "plugins/vault": "src/plugins/vault.ts",
  "plugins/index": "src/plugins/index.ts",
};

/**
 * Entries allowed to reach the server/UI/db — exempt from the library import
 * hygiene guard (they intentionally pull in the embeddable server surface). The
 * first, `server`, is the canonical embeddable entry the positive guard test
 * asserts against.
 */
export const SERVER_ENTRY = "server";
export const SERVER_COUPLED_ENTRIES = new Set([
  SERVER_ENTRY,
  "plugins/automations",
  "plugins/excel",
  "plugins/board",
  "plugins/links",
  "plugins/vault",
  "plugins/index",
]);
