# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Shorthand the user types:** **ru** = rubato (this repo), **ca** = cursedalchemy. The user uses these abbreviations in prompts and tasks to save typing — treat them as the full repo names.

> ⚠️ **rubato is MAINTENANCE-ONLY and sunsetting.** The sole active priority is `ca` + `cwip` + `cursedbelt`. rubato only needs to keep running so the orchestrator UI is accessible at `localhost:5175`. All ru tasks including `rfc-40` are on hold; no new features or ca↔ru bridges should be built. A ca-native orchestration strategy will be designed separately after the ca refactor lands. **Do not write new code for rubato unless fixing a critical regression that prevents the orchestrator UI from running.**

> 📐 **Engineering standards: `cursedbelt/STANDARDS.md`** is the ONE canonical source of truth (placement, reuse-not-duplicate, layering, Biome rules, ctgr/getOnly invariants, integration-flow workflow). **Read it before any code change** — though for rubato, new code is almost never needed (see scope note above).

## What this is

**rubato** is a personal toolbox of TypeScript dev scripts. It runs on **Bun** —
scripts are executed directly, there is no build step to use them.

The core idea: each script is registered as a memorable shell command. A user
clones the repo, runs a setup command, and gets every tool installed as a shell
function runnable from anywhere (`globalgitignore`, `goto`, `gotab`, …). Machine-
specific state (which apps exist, the editor, the code dir) lives in per-machine
config under `~/.rubato/`, generated and then user-editable.

**It's also a library.** The same building blocks are importable so other apps can
assemble their own clients/reports. The public surface is the `exports` map in
`package.json` → curated barrels: the root `src/lib.ts` (flat utilities + domain
namespaces), `src/api/index.ts` (`rubato/api`), the per-service barrels
(`rubato/jenkins|quay|gitlab`), `src/lib/deploy/index.ts` (`rubato/deploy`), and
`rubato/git|apps|config|output`. Targets are the `.ts` sources (Bun-native, no
build). **When adding broadly-reusable code, export it through the relevant barrel**
(and prefer keeping library-facing modules free of CLI/`process`/`server/db`
coupling so they import cleanly).

**Library ≠ server: the import boundary is enforced.** Importing `rubato` (the
root `src/lib.ts`) — or any library subpath — must NOT pull in the local server,
web UI, DB (`bun:sqlite`), or Playwright, so a toolkit-only consumer stays lean.
The embeddable server + UI (`on()`) lives behind its own opt-in entry: `import { on }
from "rubato/server"` (source `src/on.ts` → `dist/server.js`); apps that want the
server import it explicitly, the rest never pay for it. The entry→source map is the
single source of truth in **`scripts/libEntries.ts`** (`LIB_ENTRIES` + `SERVER_ENTRY`),
shared by `scripts/build.ts`, the package.json `exports` drift check, and the guard
test **`src/test/libImports.test.ts`** — which statically walks each entry's
transitive imports and FAILS if any library entry reaches `src/server/**`, `ui/**`,
`bun:sqlite`, `ws`, or `playwright` (only `rubato/server` may). So a stray
`import "../server/…"` in a lib module breaks the build's test gate, not someone's
production bundle. (Add a new library subpath → add it to `libEntries.ts` AND the
`exports` map together; the test asserts they match.)

**Design principle: zero-config by default.** A published user should be able to
`bun install`, run one setup command, and have things work without being prompted
or hand-editing config. Derive sensible defaults; make config optional and
overridable, never required.

**Footprint is fixed under one root.** Everything rubato reads/writes derives from
`RUBATO_HOME` (`~/.rubato`, see `src/lib/config.ts` → `OUTPUTS_DIR`, `SCRIPTS_DIR`,
the sqlite/captures/excel/… dirs). `RUBATO_HOME` is the *only* relocation knob (it
moves the whole footprint together — that's what `rubato-sandbox`/tests use); there
are deliberately **no per-directory overrides** for where generated files land, so a
machine's state can't scatter or differ from another's. Don't add a config field or
env var that points a single rubato dir somewhere else — derive it from
`RUBATO_HOME` instead.

## How it's wired

- **`src/commands.ts`** — the single source of truth. It maps each memorable
  command name → script path → `kind` (`plain` runs and streams output; `cd`
  treats stdout as a path and cd's the parent shell into it).
- **`src/scripts/<name>.ts`** — one runnable script per command. Each has a
  `main()` that reads `process.argv`. New work usually lands here.
- **`src/lib/`** — shared helpers (`config.ts` for `~/.rubato/config.json`,
  `apps.ts` for the app registry + matching/validation). An **"app"** here is the
  friendly umbrella for *any named path you jump to or run commands against* —
  usually a code repo, sometimes just a dir or a single file (e.g. `gotab zs` →
  `~/.zshrc`). `AppConfig` is two layers: a named path (every entry) plus app
  metadata (apis/db/ai/deploy) that only applies once the path is a real repo.
  `AppConfig.links` is an optional `{ text, href }[]` of user shortcut URLs
  (jenkins/quay/openshift/…); edit them in the Apps detail page (Links section),
  set via `POST /api/apps/:name/links` (→ `setAppLinks`/`normalizeAppLinks` in
  `apps.ts`, blank-href rows dropped, empty clears the field), rendered as
  open-in-new-tab chips. (A first slice of the larger repo-clone/git-config task.)
  `AppConfig.cloneUrl` is the repo's git clone URL (origin) — filled by config-fill
  or set when cloned through rubato. **Clone + config-fill** (`server/appClone.ts`):
  `POST /api/apps/clone {url,dest,name?,group?}` clones (cwip `cloneRepo`, refuses
  an existing dest) + registers the app; `POST /api/apps/fill-git-urls` backfills
  `cloneUrl` from each git repo's origin (cwip `remoteUrl`). Apps page has a "Repo
  tools" panel (clone form + "Fill missing git URLs"). Both are offline/local — no
  creds. (git-automations-into-pipelines is the only repo-clone-task part still
  unclaimed — it overlaps the automation/pipeline work.)
  Per-app **git quick-actions** (same task): `POST /api/apps/:name/git` with
  `{action: pull|fetch|checkoutDefault|commitAll, message?}` → `runAppGitAction`
  (`server/appGit.ts`, all local git via cwip helpers incl. `commitAll`/`checkout`),
  surfaced as a Git-actions row in the Apps detail page — for the "update dozens
  of apps" flow (commit WIP, checkout default, pull/fetch). The Apps detail page
  also has an **uncommitted-diff viewer**: `GET /api/apps/:name/diff` (changed-file
  list) +
  `?path=&untracked=1` (one file's unified diff) and `POST` `{action: stash|
  discardAll|discard, paths?}` → `getAppDiff`/`getAppFileDiff`/`runAppDiffAction`
  (cwip `diffNameStatus`/`fileDiff`/`stashPush`/`discardPaths`/`discardAll`). Step
  through changed files, view colorized diffs, and stash/commit/drop. clone/config-
  fill/git-automations stay queued on that task.
  **Apps template** (`/apps/templates`, linked from the Apps page) — a shared,
  **git-tracked** `apps.template.json` at the repo root (NOT in `~/.rubato/`, so
  `git pull` syncs it across machines; per-machine `apps.json` is not synced).
  Entries are the portable subset of a registry app with their path written
  home-relative via the **`<HOME>`** token (`<HOME>/.zshrc`), so the same list
  resolves on any machine/username. The page shows each entry's **applied** (in
  this machine's registry, by name then resolved path) + **path exists** status,
  lets you multi-select and add the not-yet-applied ones to `apps.json` (resolving
  `<HOME>` to an absolute path, skipping name/path/match-key clashes), and has an
  "Add apps to template" picker that home-tokenizes existing registry apps back
  into the template. Pure model + transforms in `src/shared/appsTemplate.ts`
  (browser-safe, `@shared`-imported by the UI); fs/home-dir wrapper in
  `src/server/appsTemplate.ts` (template path env-overridable via
  `RUBATO_APPS_TEMPLATE` for tests/sandbox). Routes: `GET /api/apps/template`
  (status), `POST /api/apps/template/apply|add|remove {names}` — registered before
  the generic `/api/apps/:name` handler so "template" isn't read as an app name.
  Because UI edits write the repo-tracked file (they don't auto-commit), the
  status also carries the file's **git state** (`templateGitStatus` → clean/
  modified/untracked) and the page shows a "commit so other machines can pull"
  banner with a one-click `POST /api/apps/template/commit {message?}`
  (`commitTemplate`) that commits ONLY the template file (pathspec-scoped, so
  unrelated working-tree changes are untouched) — local only, never pushes.
- **`src/api/`** — the reusable HTTP client (`createApiClient`) that service
  clients are built on: auth headers, content-type-aware parsing, `ApiError`,
  timeouts. `fetch` is injectable for tests. Secrets come from `~/.rubato/.env`
  via `requireEnv`. **`src/api/jenkins/`** is the first service client — a
  config-driven Jenkins client (`jenkinsFromConfig`) whose job paths resolve from
  per-app config (`AppConfig.apis`) with global defaults; multibranch vs not is
  configured per-app/env, never hardcoded. `rubato-init` scaffolds the config + .env.
  Other service clients follow the same shape (`*FromConfig` + injectable `fetch`):
  `src/api/{quay,gitlab,rancher,harness,splunk,openshift,rally}`. **`src/api/rally/`**
  is the Rally (WSAPI v2.0) client — API-key auth via the `ZSESSIONID` header,
  `getStory`/`getTask`/`updateTask`/`setTaskInProgress`; env-gated on `RALLY_URL`+
  `RALLY_API_KEY`. `src/server/rallyRoutes.ts` exposes `/api/rally/story/:id`,
  `/api/rally/task/:id`, `POST /api/rally/task/:id/update {state?,notes?}` — all
  **412 `needsCreds`** until creds exist (scaffolded; pipelines use-case 5).
- **Release integrity (`src/api/deploy/` + `src/lib/deploy/`)** — correlate each app's
  Jenkins build, Quay image (`manifest_digest` = the sha256), and Git commit to
  generate and **verify** hand-maintained deploy lists. `src/lib/deploy/collect.ts`
  is the shared per-app multi-source join (used by `appall`/`shalist`/`lastdeploy`);
  `src/api/deploy/` is the pure, client-injected core — `checks.ts`'s `verifyEntry`
  runs confidence-tiered checks (HARD/fail: Quay tag exists, digest == listed sha256,
  git commit exists; SOFT/warn: build correlation, etc.), `resolve.ts` maps a version
  to its Quay tag (the reliable anchor) and best-effort Jenkins build. **The version→
  build mapping is deliberately not a gate** — the trailing version segment is
  off-by-one from the build number and `displayName` often lacks the version, so
  build matching is configurable enrichment (`jenkins.versionStrategy`, global +
  per-app). `src/lib/deploy/verify.ts` is the impure seam (registry match + wiring
  live clients into the pure engine). Commands: `shalist` (generate), `verifyshas`
  (verify; exits non-zero on FAIL, best-effort `deploy_verifications` SQLite history),
  `checkimageshas` (digest existence), `scanvulns` (Quay/Clair vuln tally). The
  report-writing commands default their output into the configured output dir
  (`shalist`→`shalist.txt`, `verifyshas`→`verifyShasList.json/.csv`, `scans`→
  `scans/<app>-<build>/`) when no `--out` is given, so the web UI "Files" tab shows
  them (via `ensureOutputDir` in `src/lib/runStore.ts`).
- **`src/index.ts`** — the `rubato` umbrella command (`rubato list` / `rubato <name>`).
- **`src/server/`** — the `rubato-serve` web server (Bun's built-in server, loopback
  only): a pure `route(req)` handler with a read API + POST /api/run, SQLite run
  history (`db.ts`, bun:sqlite, `~/.rubato/rubato.sqlite`). Serves `ui/dist` in prod.
  A `/ws` WebSocket (Bun-native) broadcasts run lifecycle events via a small in-process
  emitter (`events.ts`); `POST /api/run {background:true}` fires-and-forgets, result
  arrives over the socket. Adding an event type: extend `ServerEvent` in `src/shared`.
  `GET /api/docs` (+ `/api/docs/:name`) feeds the web UI "Docs" tab, resolving docs
  fresh per request from three sources: the canonical root files (README/COMMANDS/…),
  generated docs rendered live from the registry (`commands-by-example.md` via
  `renderCommandsByExample`, so the cheatsheet can never drift), and any `*.md`
  dropped into `docs/` (appear automatically, no restart). The name→source set is
  the path-traversal guard; nothing is copied to disk. Add a generated doc by
  extending `GENERATED_DOCS` in `router.ts`.
  `GET /api/files` (+ `/api/files/content?path=`) feeds the web UI "Files" tab and
  the clickable output paths on the "Runs" tab — it browses/reads the script-output
  files under the output dir (`OUTPUTS_DIR` = `~/.rubato/outputs`, not configurable):
  the per-command `<command>.txt` captures plus any report a script writes there
  (`shalist --out <path>/…`). `src/server/files.ts` is read-only and scoped to
  the output dir, reusing the AI tools' `resolveRepoPath` guard (refuses `..`/escape
  + secret patterns) plus a realpath check against symlink escape; absolute paths are
  accepted only when they resolve back inside the dir (so a `RunRecord.outputPath`
  opens directly). Files written to a `--out` path **outside** the output dir aren't
  browsable — by design, the scope is the output dir.
  `GET /api/global-claude` (+ `POST` to write) view/edit the user's **global** Claude
  Code instructions — `~/.claude/CLAUDE.md`, or `$CLAUDE_CONFIG_DIR/CLAUDE.md` (the
  cross-project memory loaded into every session). `src/server/globalClaude.ts` is a
  deliberately fixed, derived single path (never caller-supplied → no traversal
  surface); POST takes `{content}` only, caps size, and creates the file if absent.
  Surfaced in the UI as an ungated footer-icon page (`/claude-md`, like Config).
- **Queries page (query builder)** — build/save/run SQL (postgres/mysql/mssql) +
  MongoDB queries against saved connections (web UI "Queries", toggle `ui.pages.queries`).
  Construction is `cwip/query` (in-browser preview via `toInlineSql`/`toMongoShell`);
  execution is `cwip/dbquery` on the server (`src/server/dbQueryRoutes.ts` →
  `/api/db-connections` + `/api/db-queries`; tables in `db.ts`; wire types in
  `src/shared/queryBuilder.ts`). **Connections never store a password** — a
  connection's `envKey` maps to `QB_<KEY>_URL`/`_PASSWORD`/`_USERNAME`, resolved
  process.env-first then `~/.rubato/.env`; no creds → run returns 412. Read-only
  by default (`assertReadOnlySql`); writes need per-connection `allowWrites` AND
  `QB_ALLOW_WRITES=true`. Drivers (`pg`/`mysql2`/`mssql`/`mongodb`) are optional
  installs loaded lazily — a missing driver fails only that run. Same feature
  (and shared cwip core) as cursedalchemy's /query-builder.
- **ServiceNow page** — read/update ServiceNow records via the Table API, or call
  any endpoint (passthrough), against saved connections (web UI "ServiceNow", toggle
  `ui.pages.servicenow`). The REST client + credential resolver are shared in
  **`cwip/servicenow`** (same core as cursedalchemy's /servicenow); this app is the
  glue: `src/server/servicenowRoutes.ts` → `/api/servicenow-connections` +
  `/api/servicenow-requests`; tables in `db.ts`; wire types in
  `src/shared/servicenow.ts`. **Connections never store a secret** — a connection's
  `envKey` maps to `SN_<KEY>_TOKEN` (→ Bearer) / `SN_<KEY>_PASSWORD` (+ `_USERNAME`
  → Basic) / `SN_<KEY>_URL` (instance-URL override), resolved process.env-first then
  `~/.rubato/.env`; no creds → run returns 412. Reads are always allowed; writes
  (`table_write` or a non-GET passthrough) need per-connection `allowWrites` AND
  `SN_ALLOW_WRITES=true`. Operations: table_read / table_write / passthrough.
- **Plans page (AI remediation plans)** — view/edit/export stored Markdown
  remediation plans (toggle `ui.pages.plans`). Plans are produced by the
  `ai-remediation-plan` built-in pipeline script (vuln data / attached reports →
  configured LLM → Markdown, closing the jenkins→pdf→parse→vuln chain, uses 1+3) or
  written by hand. Server: `src/server/plansRoutes.ts` (`/api/plans` CRUD),
  `remediation_plans` table in `db.ts`, wire types `src/shared/plans.ts`. The pure
  prompt/parse core is `src/lib/remediationPlan.ts` (`buildPlanPrompt`/`generatePlan`
  with an injectable `AiComplete` — mock-tested); the script wires the real provider
  via `llmFromConfig`/`completeText` and is **env-gated** (no `RUBATO_LLM_URL` → the
  stage fails gracefully). UI renders Markdown with `react-markdown`.
- **Capture (data-gathering) — now part of the Browser builder, not a separate page.**
  The old standalone `/capture` page was **merged into the automation builder** (the
  nav item is now "Browser"; `capture` is `mergedInto: 'automations'`, `/capture`
  redirects to `/automations`). Capturing is just the build session with "Capture
  screens" on: the **one** headed-browser session (`server/browserSession.ts`) records
  each interaction into an **editable** step (`recorded-step`) AND, while capturing,
  bundles the page HTML + a full-page JPEG per moment into a persisted capture session.
  The Node host already emits both for the same interaction — `arm-capture` is
  `setMode("recording")` + a `capturing` flag; `set-capture {on}` toggles capture
  without dropping the recorder (`browser-host.mjs`). A saved `Automation` carries an
  optional `capture: { id, count, startedAt, stoppedAt? }` track referencing the
  artifacts; the builder + view page render the timeline (`TimelinePlayer` +
  `manifestToMoments`) and the export/import controls. The artifact backend is
  unchanged: `captureRoutes.ts` (`/api/capture/*` — list/read/`/draft` lift/export/
  import/convert; the live-session endpoints were removed) + `lib/captureStore.ts`
  (sessions under `~/.rubato/captures/<id>/`: manifest.json + html/ + shot/) + pure
  `lib/captureBundle.ts` (gzip serialize/parse) + `lib/captureToAutomation.ts` (lift
  records → steps). Wire types `src/shared/capture.ts`. **Making captures editable:**
  a stored capture's `/draft` endpoint lifts it into an unsaved builder draft (steps
  editable) that keeps the capture track; Save promotes it to a real automation — no
  destructive migration, so existing captures + bundles still work. The session events
  are `session:recorded-step` / `session:captured` / `session:navigated` /
  `session:closed` (the old `capture:*` events were removed). Still the bridge for the
  live-only Jenkins/OpenShift work: gather over there, ship the bundle (gzip file or
  sealed string) back, finish the selectors here. Captured HTML may contain on-page
  values — it's a local data-gathering tool.
- **Board page (kanban work tasks)** — a simple Jira-like board (toggle
  `ui.pages.board`): four fixed statuses (ready/in-progress/testing/complete),
  HTML5 drag-drop between/within columns (fractional `position` for inserts),
  card editor with title/description/notes/links/images. Server:
  `src/server/boardRoutes.ts` (`/api/board` CRUD + `/upload` + `/images/:name`),
  `board_tasks` table in `db.ts`, wire types `src/shared/board.ts`. Images land
  in `~/.rubato/uploads/board/` under generated uuid names; the serve route only
  accepts that exact name shape (no traversal surface). The cursedalchemy
  sibling adds sharing on the same model.
- **Links page (bookmark / link manager)** — a searchable catalogue of URLs
  (toggle `ui.pages.links`, `/links`). Add by hand (title/url/description/folder/
  tags/notes) or **import a browser bookmarks export** (Chrome/Edge/Firefox/Safari
  `bookmarks.html`): the page reads the file as text and POSTs it to
  `/api/links/import`, which parses it with cwip's `parseBookmarksHtml` (DOM-free
  NETSCAPE parser) and bulk-inserts, mapping the bookmark folder path → `folder`
  and tagging each `imported`. `url` is UNIQUE, so creating a duplicate 409s and
  re-importing dedupes (INSERT OR IGNORE). Server: `src/server/linksRoutes.ts`
  (`/api/links` list/create-or-update + `/import` + DELETE), `links` table + CRUD
  in `db.ts`, wire types + pure `cleanTags` in `src/shared/links.ts`; folded into
  universal search (`searchRoutes.ts`). UI `ui/src/pages/LinksPage.tsx` (search +
  tag-filter chips + card grid + editor modal). The single-user sibling of
  cursedalchemy's `/links` (which scopes per user).
- **Dashboard page (per-app status overview)** — a datadog/dynatrace-style board
  (toggle `ui.pages.dashboard`) aggregating status across every registered app.
  Server: `src/server/dashboardRoutes.ts` (`GET /api/dashboard` fans out git facts
  for all apps in parallel, best-effort per app; `POST /api/dashboard/tag` tags a
  commit across a selected subset). Wire types in `src/shared/dashboard.ts`. This
  iteration is **git-only** (no external service creds needed): branch, ahead/
  behind, dirty count, local-only/remote-only branches, gone upstreams, stash
  count, tag count + recent tags. Iteration 2 adds **base-relative facts** —
  commits ahead/behind the DEFAULT branch (`aheadOfBase`/`behindBase`, computed
  only on a feature branch) and an approximate **branch-created date**
  (`branchCreatedAt` = earliest commit diverging from the base) — plus a
  cross-app **tag prefix search** (`GET /api/dashboard/tags?prefix=&apps=&limit=`).
  UI `ui/src/pages/DashboardPage.tsx`: percent-of-repos summary bars, filter chips
  (uncommitted/behind/ahead-of-main/behind-main/gone/local-only/tagged/…), a per-app
  table (incl. a "±Main" column + branch-created tooltip), a tag-search box, and a
  tag-a-subset panel. Git primitives live in cwip/node (`listTags`/`tagCommit`/
  `aheadBehindRefs`/`branchCreatedAt`). Iteration 3 adds **service-backed deploy
  columns** (the credential-gated part, built as scaffolding): `GET /api/dashboard?deploy=1`
  resolves each app's latest published image (Quay tag + sha, enriched with the
  latest Jenkins build) via `collectApps` + soft-gated `buildDeployClients` —
  `server/dashboardDeploy.ts` (`collectDeploy`/`toDashboardDeploy`). It's **opt-in**
  (the default board stays git-only/fast) and **credential-gated**: no creds → no
  client → `deployConfigured:false` + every row's `deploy` omitted, never an error.
  The UI has a "Deployed versions" toggle that re-queries with `deploy=1`, adds
  Version + Image columns, and shows a "configure creds" hint when unconfigured.
  Iteration 4 completes the **version↔sha↔commit** triple (the `commit` comes from
  the Jenkins build `collectApp` already resolves → a Commit column) and adds
  **per-environment** resolution: `GET /api/dashboard?deploy=1&env=stage` threads
  `env` → `collectDeploy` → `collectApps` (the env's Jenkins job), with an env input
  beside the toggle. Lights up for real once `QUAY_API_TOKEN`/`JENKINS_*` are in
  `~/.rubato/.env`. **Follow-ups:** a quay-API sha↔commit cross-lookup (today the
  commit is jenkins-derived), true per-env RUNTIME state (Rancher/OpenShift workload
  image), and richer charts over the service data.
- **Orchestration Processing page (per-category timing analytics)** —
  `/orchestration-processing` (top-level, opt-in/off by default), kept SEPARATE from
  the Orchestration dashboard so it doesn't clutter the Watchdog/Tasks/Runs view. It
  ingests the `orchlog` recorder's per-category `timing-*.jsonl` files (under
  `<notesDir>/orchestration/runs/`, emitted by ___Agent_Workspace/orchestration/
  orchlog.ts) into SQLite, **so the JSONL files can be deleted later while the
  analytics persist**. Server: `orchestration_timings` table + ingest/query/clear in
  `db.ts`; `src/server/orchestrationTimings.ts` reads only `timing-*.jsonl` basenames
  (no path-traversal surface), parses with **`cwip/orchestration`**'s tolerant
  `parseTimingJsonl`, and aggregates via cwip's `aggregateByCategory`/`summarize` (the
  single source of truth for the math — don't re-implement it); endpoints in
  `orchestrationRoutes.ts` (`GET /api/orchestration/timings?from&to&repo`, `POST
  .../ingest`, `POST .../clear {before?}`). Ingest is **idempotent** (`INSERT OR
  IGNORE` by `event_id`), so re-syncing is safe. Wire types + the pure
  `bucketTimingTrend` live in `src/shared/orchestration.ts` (re-exported via
  `rubato/orchestration`). UI `ui/src/pages/OrchestrationProcessingPage.tsx`: KPI
  tiles + **cwip/react charts** (`CategoryBars`/`CategoryDonut`/`TimeSeriesChart`,
  wrapped in `ChartThemeProvider(chartThemeFor(isDark))`) + a sortable per-category
  table (count/shortest/longest/average/median/total) + date/repo filters + data
  management (Sync / Clear all / Clear before a date). Source paths deep-link via
  `vscode://file/<abs>` plus the standard open-in-editor button. **recharts** is a
  cwip/react charts peer dep, installed in **`ui/package.json`** (the UI is its own
  vite-bundled workspace — that's where React + the charts get bundled).
- **Env Files page (cross-app .env compare/search)** — `/docs/env` (Docs hub, on by
  default): keep "dozens of apps' .env files in sync". Two parts, no secret ever
  leaves the box unmasked. **Search** (`GET /api/env-discovery` → `discoverEnv`,
  `src/server/envDiscovery.ts`) answers "which apps HAVE / LACK a key (or value)",
  by group or across every config carrying `.env*` files — it returns **key names
  only**, never values. **Compare** lines up the picked files in a key×source grid
  (cwip's `EnvCompare`/`diffEnvSets`, which flags missing keys + disagreeing values)
  — add one file, a whole **group** (the containing folder), or **every app** at once
  via `GroupAddRow`/"Add all to compare". Per-app `.env*` discovery/read/write is
  `src/server/envFiles.ts` (path-safe, `.env*`-name-gated, realpath-checked — the
  deliberate human-operated counterpart to the AI tools' `.env` denylist); the file
  editor lives on each app's detail page. Wire types `src/shared/envDiscovery.ts`
  (pure `matchEnvKeys`), UI `ui/src/pages/EnvComparePage.tsx`.
- **Page toggles + Admin page** — each main-nav page is individually enable-able via
  config `ui.pages.<key>` (single source of truth: `UI_PAGES` in `src/shared/ui.ts`).
  **Defaults: `apps`, `excel`, the Docs hub (`docs`/`system-files`/`env-compare`/
  `config`), and `customPages` are on; everything else is off** (see
  `defaultPageEnabled`), so a fresh UI lands on Apps and the rest are opt-in. `GET /api/ui` returns the resolved `{pages, admin}` state (the UI builds
  its nav + routes from it); `POST /api/ui` merges a toggle patch (`setUiConfig` in
  `config.ts`). The **Admin** page (toggles + DB backups + DB viewers) is gated by
  `ui.admin`, which is deliberately **not** UI-discoverable — you enable it once by hand
  with `{"ui":{"admin":true}}` in `~/.rubato/config.json`. `src/server/adminRoutes.ts`
  (`/api/admin/*`) 404s entirely when admin is off; the loopback single-user server
  has no other auth, so that config gate *is* the access model. Panels (`src/server/admin/`):
  **backups** (`backups.ts` — `VACUUM INTO` snapshots under `~/.rubato/backups`: create/
  list/delete/download, inspect a backup read-only, and **restore** selected tables over
  the live DB, taking an automatic `pre-restore-*` safety snapshot first and copying only
  shared columns inside a transaction); **live DB viewer** (`dbViewer.ts` — tables, per-
  table stats via `dbstat`, filtered queries); both read through `dbQuery.ts`, an
  **injection-safe** engine (table/column names whitelisted against the catalog, fixed
  operator map, bound params, `ESCAPE`-d LIKE) — keep all viewer/restore SQL going through
  it. Ported from a sibling app's admin dashboard (users/email panels intentionally skipped).
  UI lives in `ui/src/pages/AdminPage.tsx` + `ui/src/pages/admin/` (the reusable
  `TableQueryExplorer`/`FilterBuilder`/`DataResultsTable` drive both viewers).
- **Diagnostics (`src/lib/diagnostics/`)** — rich, exportable failure/processing
  artifacts so rubato is debuggable on *other people's* machines and against
  unfamiliar APIs. Built on the `cwip` package (redaction + stringify + ids). Two
  layers, kept apart so `src/api/*` and pure `src/lib/*` stay import-clean: **pure**
  (`shape.ts` `describeShape`/`diffShape` — the "their JSON isn't the shape we
  thought" case, exported through `rubato`; `report.ts` `classifyError` +
  report model) and **impure** (`session.ts` `startDiagnostics(...)` → a session you
  `.step/.warn/.fail/.expected(...)` then `.finish(status)`, which writes a
  `<activity>-<ts>-<id>.log.jsonl` (full step log) + `.report.json` (overview:
  status, classified error+stack, counts, shape diffs, **redacted** env/config
  snapshot) under `<outputDir>/diagnostics/`). Redaction masks every `~/.rubato/.env`
  value + secret-looking env var via cwip's `cleanDataForLogging`, so credentials
  never land in an artifact. **Wired into every failure seam** (server runs
  `run.ts`, pipelines `pipelines.ts`, automations `engine.ts` — incl. the launch
  error it used to drop, the ask top-level catch + the silent embedding→BM25
  degradation in `aiRetrieve.ts`, and the `verifyshas`/`shalist`/`scans` scripts,
  which also gained an **overview header** on their reports). Runs/pipelines store a
  `diagnosticPath` (additive wire field). **Admins view + export** them: an
  ungated-to-discover **Diagnostics** admin panel (`adminRoutes.ts`
  `/api/admin/diagnostics` list/content/download → `src/server/diagnostics.ts`,
  reusing `files.ts` scoping) plus a **Download** button on the Files tab
  (`/api/files/download`, the first non-view-only file route).
- **"Ask about your repo" (local RAG chat)** — ask questions about a registered app
  and get an answer grounded in its files (web UI "Ask" tab, or `rubato-ask`/
  `rubato-index` CLIs). `src/lib/ai/` is the pure pipeline (text filtering, chunking,
  BM25, cosine, RRF hybrid, `expand` file-context, `selfAsk` planner, prompt building);
  `src/server/ai*.ts` orchestrates it (`aiDb` chunk/vector storage in the shared SQLite,
  `aiIndex`, `aiRetrieve` scorer selection + file expansion, `ask.ts` the streaming worker).
  **Retrieval is multi-step.** Each retrieval expands the top ranked files to their
  sibling chunks (`expandFileContext`) so whole-file/enumeration questions ("list all
  routes") aren't answered from one slice. Then `ask.ts`'s `gatherContext` runs a bounded
  **self-ask loop**: after each round the planner LLM judges (plain JSON, no function-
  calling — provider-agnostic) whether the gathered context suffices and, if not, proposes
  follow-up searches. Safeguards make it always terminate: `ai.maxRetrievalRounds` cap
  (default 2; 1 = single-shot), per-query + per-chunk dedup, an "added nothing new → stop"
  check, a total-chunk budget, and planner failure ending the loop. Toggle expansion with
  `ai.expandFiles`. **Opt-in agentic tools (`ai.tools`)** go further: instead of one-shot
  retrieval the model gathers context by *calling tools* through a **provider-agnostic JSON
  protocol** (`src/lib/ai/toolProtocol.ts` — the model emits a fenced ```tool_use block, no
  native function-calling needed). `src/server/agenticAsk.ts` runs the loop (seed retrieval
  → tool rounds → stream the answer from the transcript); `src/server/tools/` holds the
  read-only repo tools (`builtins.ts`: search_repo / read_file / list_files), the `safety.ts`
  guards (path scoping + secret denylist — tools never read `.env`/keys), and a `registry.ts`
  seam where user-defined tools attach. **User tools** live in `~/.rubato/tools/*.json`
  (`userTools.ts`); the `http` type makes a templated request to an API in the environment
  (`${param}`/`${env.X}` secrets/`${api.<name>.baseUrl}` from the app's `apis` config), so the
  agent can pull *live* app data, optionally scoped to one app. Built-ins win on name clash;
  the JSON shape is deliberately a v1 to grow (see `docs/agentic-tools.md`). Bounded by
  `ai.maxToolRounds`, per-round/total call caps, exact-call dedup, and graceful degradation to
  the seed when no tool is called. The LLM is never in this repo — it's
  reached through a **provider-agnostic** layer (`src/api/llm/`: `direct` OpenAI-style,
  `form-sse` generic) configured by URL+token. Embeddings run **locally** via
  transformers.js (`src/api/embeddings/`, model staged under `~/.rubato/models` by
  `rubato-ai-setup`); retrieval is BM25 by default and upgrades to hybrid automatically
  when a model is present, degrading back to BM25 otherwise. `@huggingface/transformers`
  is an **optional peer dep** (`bun add @huggingface/transformers`), loaded lazily so
  library/CLI installs stay lean — `embeddingAvailable` checks it's resolvable (else
  BM25), and `local.ts` throws an actionable message if a feature reaches for it absent.
  The `remote` backend (`ai.embeddings.provider="remote"`) needs no ML dep at all. **Keep it provider-agnostic:
  no external product/company names in code, config keys, or docs.** Answers stream over
  `/ws` as `ask:*` events (incl. `ask:status`, transient "Searching the codebase…"/"Running
  <tool>…" progress the **Ask** tab shows before answer tokens flow, so multi-step retrieval
  never looks stuck); conversations persist in SQLite (`db.ts`). **Not every question needs a
  repo:** picking "General" (no app) in the **Ask** tab skips indexing/retrieval and asks the
  LLM directly (`app` is optional through `startAsk`/`createConversation`; general conversations
  store an empty app). Either mode can **attach files** in the composer — their text is sent as
  ad-hoc context (`AskAttachment`, capped + token-budgeted in `prompt.ts`), so you can ask about
  a file without indexing a whole app. Conversations have **multi-turn memory**: `ask.ts`
  replays prior turns (via `loadHistory`, woven in after the system prompt across the general,
  self-ask, and agentic paths), bounded by `ai.maxHistoryMessages`/`ai.maxHistoryTokens`.
  **Ask about any folder (no app):** in general mode you can point the AI at a directory
  (`fsRoot`) and it explores it with read-only filesystem tools — `getFsTools(root)` in
  `src/server/tools/fsTools.ts` (list_files/read_file/search_files, live, no index) driven
  through the same agentic loop, reusing the path-traversal + secret-denylist guards
  (`safety.ts`), so reads never leave the folder or open `.env`/keys.
- **`ui/`** — separate Vite + React 19 + Tailwind v4 workspace (own package.json /
  node_modules). Dev: `bun run dev` runs both in one terminal (prefixed output);
  or separately `bun run serve` (server :4747, `--hot` so edits to commands/server
  reload in place — no manual restart) + `bun run web:dev` (Vite :5173, proxies
  /api). Prod: `bun run web:build` then `rubato-serve` serves the bundle.
  Wire types come from `src/shared` via the `@shared` Vite alias.
  - **Result-view switcher (`ui/src/result/`)** — a shared `ResultView` that shows
    any result as a **Grid** (Excel-like sheet), **JSON**, or **CSV** download.
    Every surface normalizes into a flat `GridTable` (`table.ts`:
    `tableFromRecords`/`tableFromUnknown` — the latter returns `null` for
    non-tabular data so the grid tab hides). The grid (`SpreadsheetGrid.tsx`) is
    built on the **headless `@tanstack/react-table` + `@tanstack/react-virtual`**:
    a plain HTML table (styled with Tailwind / `dark:` classes — no canvas), row-
    virtualized, with click-to-sort + column resize; read-only by design. It's
    **lazy-loaded** (`index.tsx`) into its own small chunk. Wired into the Services
    result, Splunk results, and the admin DB viewer (`DataResultsTable` adds a
    Table/Sheet/JSON toggle). (Was briefly on glide-data-grid — swapped off for
    React-19 alignment + a lighter dep footprint.)
- **Playwright automation builder** — a visual builder (web UI → "Browser", the
  nav item that absorbed Capture) for Playwright flows: ordered steps (action +
  targeted element), an element **picker** and interaction **recorder**, optional
  per-moment **screen capture** (HTML+screenshot timeline; record-on-launch +
  capture-on-launch toggles default on), live **test-selector**, conditional `if` steps, and
  `${VAR}`/`${scraped.x}` interpolation (secrets from `~/.rubato/.env`, redacted in
  logs). Automations are user-editable JSON under `~/.rubato/automations/`; runs land
  in the `automation_runs` SQLite table. Run from the UI or `rubato-automate <name>`.
  **Export:** an automation can be rendered to a standalone `@playwright/test` spec
  another app drops into its own e2e suite — `src/lib/exportSpec.ts` is the pure
  codegen (kept in lockstep with `browser-host.mjs`'s `resolveLocator`/`execAction`),
  surfaced as `rubato-export <name>` and `GET /api/automations/:id/export` (UI "↓ Export").
  **Multi-target fan-out:** `POST /api/automations/run` accepts `urls?: string[]` —
  it fans the automation across those URLs, one parallel `runAutomationHeadless`
  (own browser context/window) each (headed + keepOpen leaves them all open). The
  pure planner is `src/server/multiRun.ts` `planAutomationRuns` (overrides each
  run's `startUrl` to the URL + injects a `TARGET_URL` var; capped at
  `MAX_PARALLEL_TARGETS`, extras reported as `skipped`) — zero engine changes. UI:
  a "Run across URLs" textarea in `RunControls`' options popover. (Follow-up: tag
  the per-run ws events with `targetUrl` so the live view disambiguates N runs.)

  **Key constraint:** Playwright can't be driven from Bun (`chromium.launch` and
  `launchServer`+`connect`-from-Bun both hang on the IPC/WS handshake). So all
  Playwright calls live in a **Node** subprocess — `src/scripts/browser-host.mjs`
  (plain .mjs, run with `node`) — driven over a JSON-line **stdio protocol**. The
  split: Bun owns the testable logic (`src/lib/interpreter.ts`, `locator.ts`,
  `interpolate.ts`, `automations.ts`); `src/server/browserHost.ts` is the Bun RPC
  wrapper implementing `BrowserDriver`; `engine.ts` runs headless; `browserSession.ts`
  holds the one headed build browser **and** the capture track (recording + capturing
  share it); `automationRoutes.ts` serves `/api/automations` + `/api/session/*`
  (incl. `capture`/`snapshot`/`status`). Protocol/wire types live in `src/shared/automation.ts`.
  **Prerequisites:** `node` on PATH, plus `playwright` — an **optional peer dep**
  (`bun add playwright`), not a hard dependency, so library/CLI-only installs stay
  lean. `browserHost.ts` preflights both and throws an actionable message if either
  is missing. Drives your installed Google Chrome by default (`channel: "chrome"`),
  falling back to Playwright's bundled Chromium when present
  (`bunx playwright install chromium`).
- **`src/scripts/setup-aliases.ts`** (`rubato-setup`) reads the registry, generates
  `~/.rubato-scripts/aliases.sh` (one shell function per command, resolving `bun`
  at call time), and injects an idempotent managed block into the user's shell rc
  that sources it.

Commands are shell **functions**, not bare `bun run` aliases, so they pass args
through cleanly and so `cd`-kind commands can change the caller's directory (a
subprocess can't cd its parent — it prints the path and the function cd's into it).

### Adding a command

1. Add `src/scripts/<name>.ts` with a `main()` reading `process.argv`.
2. Add an entry to `COMMANDS` in `src/commands.ts` (pick `plain` or `cd`).
3. Run `rubato-setup` and re-source the shell rc (or open a new terminal).

See `COMMANDS.md` for the user-facing cheatsheet of every command.

## Commands (dev)

All run from the repo root. Bun is the runtime, package manager, and bundler.

```bash
bun run setup          # provision this checkout (root + ui installs; see flags below)
bun install            # install deps (root only — `bun run setup` does root + ui)
bun run tsc            # typecheck (tsc --noEmit)
bun run lint           # biome lint --write --unsafe ./src
bun run biome          # biome check (format + lint) --write --unsafe ./src
bun run test           # bun test (unit · integration · functional)
bun test path/to/file.test.ts                     # run one file (tests are *.test.ts)
bun test path/to/file.test.ts -t "name substring" # run one test by name
bun run serve          # run the API server only (rubato-serve, --hot) → http://localhost:4747
bun run dev            # server + Vite UI together in one terminal (prefixed [server]/[web])
bun run e2e            # Playwright smoke suite — boots rubato-serve, drives Chrome
bun run e2e:grep "<pattern>"   # run ONLY e2e specs whose title matches (one flow, not the whole suite)
bun run done           # the pre-land gate: tsc + biome check + tests (add --e2e for Playwright)
```

- **Verify gate:** scope it to the change — default `tsc`+`lint`+`test`; add functional/e2e only when you touched that layer (targeted browser test, not the whole suite); run the full `bun run done` sweep ONCE at batch finalize, not per task. See "Verify gate tiering" in `~/.claude/CLAUDE.md`.
- **Filter the unit suite while iterating** — don't re-run all of `bun test` for one change:
  - `bun test path/to/file.test.ts` — run a single test FILE.
  - `bun test path/to/file.test.ts -t "name substring"` — run a single test BY NAME.
  - `bun test src/server` — run every test under a directory.
- **Filter the e2e suite** — `bun run e2e:grep "<pattern>"` runs only specs whose title matches the
  `-g` regex (e.g. `bun run e2e:grep "orchestration processing"`), so a UI change runs ONE flow's
  spec, not all of `e2e/`. (ru's e2e is single-user against one isolated `RUBATO_HOME`; there is no
  per-worker DB split — keep e2e cost down by grepping to the touched flow, then run the full `bun
  run done --e2e` sweep once at batch finalize.)

Run a script directly while developing (before/without installing aliases):

```bash
bun run src/scripts/<name>.ts [args]
```

### Testing — the testkit, the four layers, and the gate

**Land only when `bun run done` is green** (tsc + non-mutating `biome check` +
the whole `bun test` suite; add `--e2e` for the Playwright smoke). A feature
should add tests at the right layer — pick with this tree:

| The thing under test | Layer | How |
| --- | --- | --- |
| A pure function / a client with injectable `fetch` | **unit** | co-located `*.test.ts`, plain inputs |
| A `route()` endpoint, a `*FromConfig()` client, the deploy/LLM seam | **integration** | `src/test/integration/*.int.test.ts` + `useHarness()` |
| The whole server process (boot, routing, a live outbound call) | **functional** | `src/test/functional/*.func.test.ts` + `useFunctional()` |
| A user-facing UI flow in a browser | **e2e** | `e2e/*.spec.ts` (Playwright) |

**The testkit (`src/test/`, import from `../index`)** makes setup one line — reuse
it, don't hand-roll:
- **`useHarness()`** — in a `describe`, wires beforeAll/afterAll to start the
  **fake upstream** + seed an isolated home + tear down. Returns `{ fake, seed }`.
  Drive the in-process handler with **`apiGet` / `apiPost`**.
- **`useFunctional()`** — everything `useHarness` does **plus** a real
  `rubato-serve` subprocess (`startTestServer`); returns `{ fake, seed, server }`,
  hit it via `server.request(path, init)`. (`src/test/server.ts`'s `startTestServer`
  now delegates to cwip/testing's hardened spawn+health-poll, so `server.logs()` is
  available too.)

**Test Reports (`/test-reports` + `bun run test:report`).** `bun run test:report`
runs the suite → JUnit → a cwip `TestRunReport` written to `TEST_REPORTS_DIR`
(`~/.rubato/test-reports`, outside any isolated home so a real serve can read it);
`e2e/playwright.config` feeds the same `cwip/e2e/reporter`. The **Test Reports** page
(Results hub) renders the shared **`cwip/react` `<TestReportViewer>`** (pass/fail,
failures, debug artifacts) over `/api/test-reports[/:id[/artifacts/:name]]`
(`testReportsRoutes.ts`, backed by `cwip/test-report`'s reader).
- **`fakeUpstream.ts`** — one `Bun.serve` impersonating every external API under a
  `/<service>/…` prefix (Splunk/Jenkins/Quay/GitLab/GitHub/Datadog/Dynatrace/
  Rancher/Harness/LLM-SSE). Records `requests`; set `.handler` to force a
  404/500/specific digest.
- **`seed.ts`** (`seedHome`) — config with every service `baseUrl` → the fake, a
  test-app registry (real scaffolded git repos with `apis`), fake creds.
- **`fixtures.ts`** — `anApp()` / `withApis()` / `aDeployEntry()` builders.
- **`resetRubatoState()`** — clears all four caches + the db in one call.
- **`setup.ts`** — the `bunfig.toml` `[test] preload` that points `RUBATO_HOME` (+
  `CLAUDE_CONFIG_DIR`) at throwaway temp dirs *before any module loads*, so the
  suite can never touch real `~/.rubato`. **Don't remove this.**

**Everything seeds a home the same way** — `provisionSandbox()` (the `rubato-sandbox
up()` core, exported from `src/scripts/sandbox.ts`) backs the sandbox CLI, the
testkit's `seedHome`, and the e2e `global-setup`. So "test in a sandbox" is the
default substrate across all layers, not a separate setup.

**Scripts must guard execution** with `if (import.meta.main) …` around the
`main()` call, so importing a script for a test never runs its CLI (network/git/
`process.exit`). All current scripts do; new ones must too.

**Scripts with real logic should expose `run(args, io)`** instead of burying it in
`main()` — it **returns** an exit code (never `process.exit`) and prints through a
`ScriptIo` seam (`src/lib/scriptIo.ts`), so a test exercises arg-parsing, branching,
exit codes, and output **in-process** with `captureIo()` (`src/test/io.ts`) — no
subprocess. The wrapper is one line:

```ts
export async function run(args: string[], io: ScriptIo = consoleIo): Promise<number> { … }
if (import.meta.main) process.exit(await run(process.argv.slice(2)));
```

`verifyshas` / `shalist` follow this (see `verifyshas.int.test.ts`); convert other
scripts to it as you touch them. Thin wrappers (parse args → call one already-tested
lib fn → print) don't need it.

### Provisioning a checkout / worktree (`bun run setup`)

`scripts/setup.ts` makes a checkout able to fully build, run, and test — installs
deps on **both** workspaces (root + `ui/`, each has its own `node_modules`) and,
on request, the heavier optional pieces:

```bash
bun run setup              # root + ui installs — what every checkout/worktree needs
bun run setup --browsers   # + download Playwright Chromium (only where system Chrome is absent)
bun run setup --ai         # + stage the local embedding model (rubato-ai-setup)
bun run setup --full       # everything
```

`playwright` + `@huggingface/transformers` are optional peer deps but are also in
devDependencies, so the installs already fetch them; the e2e suite drives your
installed Google Chrome (`channel: "chrome"`), so `--browsers` is normally unneeded.

### Running the app + e2e from a worktree (isolation)

Several worktrees can run the app at once because all per-machine state is
relocatable and the port is configurable — give each worktree its own:

```bash
# isolated app: throwaway state + a non-default port (won't touch ~/.rubato or :4747)
RUBATO_HOME="$PWD/___rubato-home" RUBATO_PORT=4848 bun run serve
# isolated e2e: the config already points RUBATO_HOME at a gitignored throwaway;
# just pick a free port (defaults to 4799)
RUBATO_PORT=4799 bun run e2e
```

- **`RUBATO_HOME`** → a throwaway dir means the run sees an empty registry/config/db
  instead of `~/.rubato` (use a `___*` or `*.ignore*` name so it's gitignored).
- **`RUBATO_PORT`** → a unique port per worktree avoids the loopback `:4747` clash.

The e2e suite lives in `e2e/` (`playwright.config.ts` + `*.spec.ts`): its
`webServer` boots `rubato-serve` against a gitignored throwaway `RUBATO_HOME` and
asserts `/api/health` + the UI loads, so it never needs real data. It works with
or without `bun run web:build` (there's a no-build fallback UI). This is the first
slice of the planned full e2e harness (see Future plans).

## Conventions

- **`*.ignore.*` and `___*`** are throwaway/private — see the global CLAUDE.md.
  In this repo: `___Notes`, `___Prompts`, `___files_for_later`, `___linked`, and
  `*.ignore*` dirs for disposable test output / homes.
- **Biome** with double quotes, 2-space indent, 120 cols (`biome.json`). Run
  `bun run lint` before committing and match the surrounding file's style.
- **Per-machine state never goes in the repo.** Config and the app registry live
  in `~/.rubato/`; generated shell lives in `~/.rubato-scripts/`. Both are
  user-editable and outside version control.
- **`RUBATO_HOME` relocates all state** (config, apps, `.env`, runs db). Set it to
  test commands against a throwaway dir without touching the real registry:
  `RUBATO_HOME=/tmp/x rubato-scan`. `rubato-sandbox` builds on this to scaffold a
  full fake-app playground (`up` / `shell` / `down`) — use it to dogfood or verify
  command changes end-to-end.

## Git workflow — worktrees + the integration flow (always-green main)

**This repo runs the multi-app refactor on a parallel `refactor/integration` branch
so the owner's localhost — which runs off `main` — stays ALWAYS GREEN.** Individual
tasks may land **intermediate-broken**, cross-repo states on `refactor/integration`;
`main` is **promotion-only** and only ever fast-forwards to a *verified-green*
integration via the cross-repo promotion gate (the evolved `main-health-watchdog`).
See `docs/integration-worktrees.md` for the layout + symlink wiring.

**The policy** — land finished + verified work automatically, local-only (never push
or open a PR without asking), one worktree per task, clear the primary before
branching, and resolve conflicts yourself — lives in the global CLAUDE.md. The
integration-flow specifics that OVERRIDE the global "merge to the default branch"
default:

- **Branch your task worktree FROM `refactor/integration`, not `main`.** Name it
  `<slug>-integration` so the first-party symlink guard resolves the *integration*
  builds of `cwip`/`cursedbelt` (the `-integration` suffix is the signal — see
  `relinkFirstParty.ts`). If this repo somehow has no `refactor/integration` branch,
  fall back to `main`.
- **Merge BACK into `refactor/integration`, NEVER into `main`.** Do not commit on or
  merge to `main` — the promotion gate owns it.
- **Scope the verify gate to YOUR OWN repo** and ALWAYS confirm it still builds
  (`bun run build`) before marking done. Cross-repo or whole-SYSTEM breakage on
  integration is **tolerated** — a later heal task fixes it — provided your own
  change is correct and adds no unexpected NEW breakage in *this* repo. **"verified"
  here means `bun run done` is green** for this repo (tsc + `biome check` + the full
  `bun test` suite; add `--e2e` when you touched the UI), and the change added tests
  at the right layer (see "Testing" above).
- **First-party deps are SYMLINKED, never `bun link`-copied.** `bun run setup` +
  `bun run relink` wires `cwip`/`cursedbelt` per variant; never downgrade code to
  "fix" a missing first-party export — relink instead.

**Never leave finished work uncommitted for me to review.** If a change is done and
the verify gate passes, commit it and merge it to `refactor/integration` **without
asking and without waiting for me to eyeball it** — that includes UI/visual changes.
Don't end a turn with completed edits sitting unstaged or stranded on a feature
branch. If the gate fails or the change genuinely isn't finished, say so plainly.

```bash
# Start a feature (on the integration flow)
ROOT=$(git worktree list | head -1 | awk '{print $1}')   # primary checkout (stays on main, promotion-only)
INT="$ROOT/../rubato-integration"                         # the permanent integration worktree (refactor/integration)
git -C "$ROOT" status --short                            # 0. nothing stranded? (commit it first if so)
SLUG=feat/<short-kebab-slug>                              # feat | fix | chore | refactor
WT="$ROOT/../rubato-worktrees/<short-kebab-slug>-integration"   # -integration suffix → integration symlinks
git -C "$ROOT" worktree add -b "$SLUG" "$WT" refactor/integration
cd "$WT" && bun run setup && bun run relink               # root + ui deps, then per-variant first-party symlinks

# Land it (only when done AND this repo's verify gate is green)
git merge refactor/integration                            # from inside $WT: fold integration in, resolve here
git -C "$INT" merge --ff-only "$SLUG"                     # advance refactor/integration in its worktree (ff-only)
cd "$ROOT" && git worktree remove "$WT" && git branch -d "$SLUG"
# main is NOT touched here — the promotion gate fast-forwards it once the whole system is green.
```

Rubato specifics:
- **Deps:** a fresh worktree needs `node_modules` on **both** sides (root + `ui/`),
  so run `bun run setup`, not a bare `bun i`. If you added deps, also run
  `bun install` (root) and `bun install` in `ui/` on the integration worktree after
  merging so it runs there.
- **First-party symlinks, not `bun link`.** `relinkFirstParty.ts` writes direct,
  variant-aware symlinks for `cwip`/`cursedbelt` (an `-integration` checkout resolves
  the `*-integration` siblings; any other resolves the plain ones), so a first-party
  edit is always live and never a stale registry copy — the bug class that used to
  break `main`. Runs as `postinstall` + the tail of `bun run setup` + `bun run relink`
  (manual). **You no longer need `bun link cwip`.** Don't "fix" a missing-cwip-export
  typecheck error by downgrading the code — relink. Do not publish cwip without being
  asked.
- **Verify before landing** with `bun run tsc`, `bun run lint`, and `bun test`;
  after resolving a `git merge refactor/integration`, re-run them — never land a
  broken `refactor/integration` for your OWN repo's scope.
- **Run the app / e2e from a worktree** without colliding with the primary or
  `:4747` by giving it an isolated `RUBATO_HOME` + `RUBATO_PORT` — see "Running the
  app + e2e from a worktree" under Commands (dev).
- **`rubato-scan` prunes `*-worktrees/`** and skips linked worktrees (`.git` is a
  file), so feature checkouts (a sibling `rubato-worktrees/` dir under `~/code`)
  never pollute the app registry.

## Future plans — DEFERRED (rubato is sunsetting)

rubato's expansion plans (a more capable server + UI, richer e2e coverage, rfc-40
rubato↔ca integration, the orchestrator UI enhancements) are **all deferred
indefinitely**. rubato only needs to keep the orchestrator UI (`localhost:5175`)
running. No new features, no new commands, no server/UI expansion.

Reference files for any future plans that may still be relevant are parked in
`___files_for_later/` — do not build from them without the owner's explicit sign-off.
