/**
 * SQLite-backed run store for the rubato server (bun:sqlite — no dependency).
 * Stored per-machine alongside the rest of rubato's state in ~/.rubato.
 *
 * Two tables:
 *   - `runs`     — the latest run of each command (one row per command, upserted;
 *                  replaced on the next run). The canonical output also lives in a
 *                  file under the configured output dir (see lib/runStore).
 *   - `archives` — snapshots kept on purpose from the UI (full output inline, so
 *                  they survive the file being overwritten). Viewable/deletable.
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { groupOf, isCategoryKey, type TimingEvent } from 'cwip/orchestration';
import { addColumnIfMissing, applyRecommendedPragmas } from 'cwip/sqlite';
import { RUBATO_HOME } from '../lib/config';
import { migrateAutomationsDb } from '../plugins/automations';
import type { AutomationRunRecord } from '../shared/automation';
import type { AutomationEnvironment, EnvVar } from '../shared/automationEnvironment';
import type { BoardTask, BoardTaskInput } from '../shared/board';
import type { CustomPage, CustomPageInput } from '../shared/customPage';
import { cleanTags, type LinkImportResult, type LinkItem, type LinkItemInput } from '../shared/links';
import type { PipelineRunRecord } from '../shared/pipeline';
import type { Plan, PlanInput } from '../shared/plans';
import type { DbConnection, DbConnectionInput, SavedDbQuery, SavedDbQueryInput } from '../shared/queryBuilder';
import type { Environment, HttpRequest, SavedRequest } from '../shared/request/model';
import type { SnConnection, SnConnectionInput, SnSavedRequest, SnSavedRequestInput } from '../shared/servicenow';
import type {
  ArchiveRecord,
  AskSource,
  ChatMessage,
  ChatRole,
  Conversation,
  MessageTrace,
  RunHistoryRecord,
  RunRecord,
  SaveCommand,
  SaveCron,
  SaveCurlRequest,
  SavedCommand,
  SavedCron,
  SavedCurlRequest,
  SavedRegex,
  SaveRegex,
  ToolEvent,
} from '../shared/types';
import type { VulnerabilityInput, VulnerabilityRecord } from '../shared/vulnerabilities';

let db: Database | null = null;

/**
 * Test-only: close the handle and delete the SQLite files under RUBATO_HOME so
 * the next `getDb()` rebuilds a fresh, empty database. Lets an integration test
 * start from a clean DB without a subprocess. No-op in normal use.
 */
export function __resetDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(resolve(RUBATO_HOME, `rubato.sqlite${suffix}`), { force: true });
    } catch {
      // not present — fine.
    }
  }
}

/** The shared per-machine SQLite handle (runs, archives, conversations, AI chunks). */
export function getDb(): Database {
  if (db) return db;
  mkdirSync(RUBATO_HOME, { recursive: true });
  db = new Database(resolve(RUBATO_HOME, 'rubato.sqlite'));
  // Tune SQLite via the shared cwip baseline: WAL + synchronous=NORMAL + a 5s
  // busy_timeout (queue a writer instead of failing SQLITE_BUSY when the server
  // and a background run touch the DB at once) + wal_autocheckpoint to bound -wal
  // growth. foreign_keys stays at SQLite's default (off) for this local store.
  applyRecommendedPragmas(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      output TEXT NOT NULL,
      output_path TEXT,
      diagnostic_path TEXT,
      report_path TEXT,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      output TEXT NOT NULL,
      output_path TEXT,
      diagnostic_path TEXT,
      report_path TEXT,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      archived_at INTEGER NOT NULL
    )
  `);

  // Append-only run history: every run (registry or saved command), pruned to the
  // most recent N per command. Powers the per-command "when did I run what" timeline.
  db.run(`
    CREATE TABLE IF NOT EXISTS run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      output TEXT NOT NULL,
      output_path TEXT,
      diagnostic_path TEXT,
      report_path TEXT,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'builtin'
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS run_history_command ON run_history(command, started_at DESC)');

  // User-saved commands: arbitrary shell command lines, or saved invocations of a
  // registry command with preset args. Editable/runnable from the Commands page.
  db.run(`
    CREATE TABLE IF NOT EXISTS saved_commands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      cwd TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Per-command run stats (run count + last-run), keyed by (scope, key): a
  // builtin registry command by name, or a saved command by its id. Bumped once
  // per user-initiated run; powers the Commands page "most/least often/recently
  // ran" sorts. Independent of run_history (which is pruned per command).
  db.run(`
    CREATE TABLE IF NOT EXISTS command_stats (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER,
      last_exit_code INTEGER,
      PRIMARY KEY (scope, key)
    )
  `);

  // Automation tables (automation_runs + its additive columns) are owned by the
  // automations plugin, so the schema travels with the feature. The monolith runs
  // every plugin's DDL here; a friend app gets it via `startApp` → plugin.migrateDb.
  migrateAutomationsDb(db);

  // Pipeline runs (append-only history). Mirrors automation_runs; `stages` and
  // `vars` are JSON, `dir` is the per-run working directory (browsable in Files).
  db.run(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline TEXT NOT NULL,
      status TEXT NOT NULL,
      stages TEXT NOT NULL,
      vars TEXT NOT NULL,
      dir TEXT NOT NULL,
      diagnostic_path TEXT,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `);

  // Deploy-list verification history: one row per verified entry, append-only,
  // so "was this sha ever verified-good?" / "when did app X's prod version change?"
  // is answerable. Best-effort — verifyshas still emits its report if this fails.
  db.run(`
    CREATE TABLE IF NOT EXISTS deploy_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      verified_at INTEGER NOT NULL,
      list_path TEXT,
      app TEXT NOT NULL,
      version TEXT NOT NULL,
      commit_sha TEXT,
      image_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      issues TEXT NOT NULL,
      warnings TEXT NOT NULL,
      metadata TEXT NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS deploy_verifications_app ON deploy_verifications(app, verified_at DESC)');

  // "Ask about your repo" conversation history (the chat tracks itself, so it
  // works without any external chat app).
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      title TEXT,
      fs_root TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS conversations_app ON conversations(app, updated_at DESC)');
  // Migrate older conversation tables that predate the persisted ask folder.
  addColumnIfMissing(db, 'conversations', 'fs_root', 'TEXT');
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT,
      tool_events TEXT,
      sources TEXT,
      model TEXT,
      trace TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at)');

  // Saved developer-tool items (the Tools tab): curl/fetch requests + regexes.
  db.run(`
    CREATE TABLE IF NOT EXISTS saved_curl_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      request TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS saved_regexes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      pattern TEXT NOT NULL,
      flags TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS saved_crons (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      expression TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Request builder: saved HTTP requests + Postman-style environments.
  db.run(`
    CREATE TABLE IF NOT EXISTS http_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT,
      request TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS http_environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variables TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS db_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connection TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS db_saved_queries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS servicenow_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connection TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS servicenow_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      request TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS board_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Links (bookmark / link manager): a searchable catalogue of URLs, added by
  // hand or imported from a browser bookmarks export. `tags` is a JSON array;
  // `url` is UNIQUE so re-importing dedupes (INSERT OR IGNORE in importLinks).
  db.run(`
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      folder TEXT NOT NULL DEFAULT '',
      favicon TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_links_url ON links(url)`);
  // Vault: an encrypted, master-password-gated credential store (single-user
  // sibling of cursedalchemy's /vault). `vault_items.data` is each item's content
  // encrypted at rest with a SERVER-held key kept in ~/.rubato/.env — NOT in this
  // DB — so a DB-only leak yields ciphertext. `vault_meta` is one row holding the
  // master-password hash/salt (the separate gate). Crypto + the unlock-token gate
  // live in server/vaultRoutes.ts; this layer only stores the opaque blob + hash.
  db.run(`
    CREATE TABLE IF NOT EXISTS vault_items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS vault_meta (
      id TEXT PRIMARY KEY,
      master_hash TEXT NOT NULL,
      master_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Custom Pages: user-built dashboards. `data` is JSON of { icon?, description?,
  // layout } where layout is the cwip/layout `LayoutView` node tree.
  db.run(`
    CREATE TABLE IF NOT EXISTS custom_pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // AI remediation plans: stored Markdown docs (produced by the `ai-remediation-plan`
  // pipeline script or written by hand) that the user views/edits/exports.
  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      app TEXT,
      source TEXT,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Per-app security-scan stats (AppScan/ASoC), latest per (app, scan_type) —
  // populated by the `appscan-pdf` pipeline script; powers the Vulnerabilities view.
  db.run(`
    CREATE TABLE IF NOT EXISTS app_vulnerabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app TEXT NOT NULL,
      scan_type TEXT NOT NULL DEFAULT '',
      critical INTEGER NOT NULL DEFAULT 0,
      high INTEGER NOT NULL DEFAULT 0,
      medium INTEGER NOT NULL DEFAULT 0,
      low INTEGER NOT NULL DEFAULT 0,
      informational INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      issue_types TEXT,
      source_file TEXT,
      report_name TEXT,
      linked_app TEXT,
      raw TEXT,
      scanned_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS app_vulnerabilities_app_scan ON app_vulnerabilities(app, scan_type)');
  // Excel Automations: upload a workbook, apply an ordered list of declarative
  // steps (the cwip/excel-engine step engine), keep an immutable original + a
  // revision chain. Single-user (no user_id / sharing — that's cursedalchemy's
  // multi-user sibling). Revision workbook bytes live on disk under
  // ~/.rubato/excel/<automationId>/<revisionId>.xlsx; rows hold only metadata.
  db.run(`
    CREATE TABLE IF NOT EXISTS excel_automations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'xlsx',
      source_name TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      original_revision_id TEXT,
      current_revision_id TEXT,
      result_revision_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS excel_revisions (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_revision_id TEXT,
      seq INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'step',
      produced_by_step_index INTEGER,
      produced_by_step_id TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      hidden_mask_json TEXT NOT NULL DEFAULT '{}',
      step_result_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_excel_revisions_automation ON excel_revisions(automation_id, seq)');
  db.run(`
    CREATE TABLE IF NOT EXISTS excel_recipes (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]'
    )
  `);
  // Migrate older message tables that predate the debug trace column.
  addColumnIfMissing(db, 'messages', 'trace', 'TEXT');

  // Migrate a pre-existing runs table (append-only, no output_path) to the
  // latest-per-command shape: add the column, collapse duplicate commands
  // keeping the newest, then add the unique index that powers the upsert.
  addColumnIfMissing(db, 'runs', 'output_path', 'TEXT');
  db.run('DELETE FROM runs WHERE id NOT IN (SELECT MAX(id) FROM runs GROUP BY command)');
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS runs_command ON runs(command)');

  // Migrate tables that predate the diagnostic_path column (links a run to its
  // diagnostic report). Additive — older rows simply carry NULL.
  for (const table of ['runs', 'run_history', 'archives', 'pipeline_runs']) {
    addColumnIfMissing(db, table, 'diagnostic_path', 'TEXT');
  }

  // Migrate tables that predate report_path (links a run to the structured data
  // report its command wrote, `<command>.report.json`). Additive — older rows NULL.
  for (const table of ['runs', 'run_history', 'archives']) {
    addColumnIfMissing(db, table, 'report_path', 'TEXT');
  }

  // (automation_runs' additive columns now live in the automations plugin's
  // migrateAutomationsDb, called above.)

  // app_vulnerabilities gains the `informational` severity (the 5th AppScan tier),
  // the per-issue-type breakdown JSON, and the stored-report file name (for the
  // in-UI PDF viewer). All additive — older rows carry 0 / NULL. (addColumnIfMissing
  // no-ops when the table doesn't exist yet, matching the prior `vCols.length &&` guard.)
  addColumnIfMissing(db, 'app_vulnerabilities', 'informational', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'app_vulnerabilities', 'issue_types', 'TEXT');
  addColumnIfMissing(db, 'app_vulnerabilities', 'report_name', 'TEXT');
  // The registry app a scan is associated with (a Jenkins/Harness app — where the
  // scan's code is deployed). Additive; older rows carry NULL (unassociated).
  addColumnIfMissing(db, 'app_vulnerabilities', 'linked_app', 'TEXT');

  // Orchestration timings: per-category work-timing events ingested from the
  // orchlog recorder's `timing-*.jsonl` files (see the Orchestration Processing
  // page). One row per orchlog event, keyed by its stable `event_id` so a
  // re-ingest is idempotent (INSERT OR IGNORE). Ingesting into SQLite means the
  // source JSONL files can be deleted later while the analytics persist.
  // (`category_group`, not `group` — `group` is a SQLite reserved word.)
  db.run(`
    CREATE TABLE IF NOT EXISTS orchestration_timings (
      event_id TEXT PRIMARY KEY,
      session TEXT,
      worker TEXT,
      task_id TEXT,
      task_title TEXT,
      repo TEXT,
      category TEXT NOT NULL,
      category_group TEXT,
      kind TEXT,
      command TEXT,
      exit_code INTEGER,
      ok INTEGER,
      note TEXT,
      start_iso TEXT,
      end_iso TEXT,
      duration_ms INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      source_file TEXT,
      ingested_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS orchestration_timings_ts ON orchestration_timings(ts)');
  db.run('CREATE INDEX IF NOT EXISTS orchestration_timings_category ON orchestration_timings(category)');
  db.run('CREATE INDEX IF NOT EXISTS orchestration_timings_repo ON orchestration_timings(repo)');

  // Shell aliases: saved name→command pairs managed via the Aliases page.
  // Can be applied to the system shell config or exported to cursedalchemy.
  db.run(`
    CREATE TABLE IF NOT EXISTS shell_aliases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ui_prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  // ── Task Draft Forge ──────────────────────────────────────────────────────
  // Rough human drafts (`task_drafts`, never overwritten) get rewritten by the
  // local Ollama into queue-ready specs stored as `enhanced_tasks` revisions
  // (one row per iteration). `forge_prompts` are reusable refinement prompts.
  db.run(`
    CREATE TABLE IF NOT EXISTS task_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      raw_content TEXT NOT NULL DEFAULT '',
      target_status TEXT NOT NULL DEFAULT 'draft',
      enhance_state TEXT NOT NULL DEFAULT 'idle',
      pending_prompt TEXT,
      pending_prompt_id INTEGER,
      current_enhanced_id INTEGER,
      published_task_id INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS enhanced_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL,
      iteration INTEGER NOT NULL,
      ai_specification TEXT NOT NULL,
      status TEXT NOT NULL,
      model_used TEXT,
      prompt_used TEXT NOT NULL,
      prompt_id INTEGER,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_enhanced_draft ON enhanced_tasks (draft_id)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS forge_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Seed the built-in default prompt once (first boot / empty table).
  const promptCount = (db.query(`SELECT COUNT(*) AS n FROM forge_prompts`).get() as { n: number }).n;
  if (promptCount === 0) {
    const ts = new Date().toISOString();
    db.run(`INSERT INTO forge_prompts (name, body, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`, [
      'Technical Specification Writer',
      DEFAULT_FORGE_PROMPT,
      ts,
      ts,
    ]);
  }
  return db;
}

/** The built-in default forge prompt: turn a rough draft into a queue-ready spec.
 *  The trailing JSON line (model/think grade) is parsed off at publish time and
 *  mapped to the taskq task's model/think — see `parseSpecMeta` in forge.ts. */
export const DEFAULT_FORGE_PROMPT = [
  'You are a Professional Technical Specification Writer for an autonomous coding task queue.',
  "Rewrite the user's rough task draft into a clear, well-structured specification that an",
  'autonomous coding agent can pick up and execute without further clarification.',
  '',
  'Output GitHub-flavored Markdown with these sections (omit one only if truly irrelevant):',
  '- A one-line restated objective.',
  '- **Context** — why this is needed and any relevant background.',
  '- **Requirements** — concrete, testable bullet points.',
  '- **Implementation notes** — likely files, approach, and edge cases.',
  '- **Acceptance criteria** — how to verify it is done.',
  '',
  "Stay faithful to the user's intent; do not invent scope. Be concise but complete.",
  '',
  'After the markdown, output ONE final line of JSON ONLY (no code fence) grading the work:',
  '{"model":"haiku|sonnet|opus","think":"off|low|medium|high|max"}',
  'Pick the cheapest model + thinking that fits (mechanical → haiku/off; normal feature →',
  'sonnet/low; hard design or debugging → opus/high).',
].join('\n');

/** Get a UI preference by key (returns null if not set). */
export function getUiPref(key: string): string | null {
  const row = getDb().query<{ value: string }, [string]>(`SELECT value FROM ui_prefs WHERE key = ?`).get(key);
  return row?.value ?? null;
}

/** Set a UI preference (upsert). */
export function setUiPref(key: string, value: string): void {
  getDb()
    .query<unknown, [string, string]>(
      `INSERT INTO ui_prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

interface RunRow {
  id: number;
  command: string;
  args: string;
  exit_code: number;
  output: string;
  output_path: string | null;
  diagnostic_path: string | null;
  report_path: string | null;
  started_at: number;
  duration_ms: number;
}

interface ArchiveRow extends RunRow {
  archived_at: number;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    command: row.command,
    args: JSON.parse(row.args),
    exitCode: row.exit_code,
    output: row.output,
    outputPath: row.output_path ?? undefined,
    diagnosticPath: row.diagnostic_path ?? undefined,
    reportPath: row.report_path ?? undefined,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  };
}

function toArchive(row: ArchiveRow): ArchiveRecord {
  return { ...toRecord(row), archivedAt: row.archived_at };
}

/** Record (or replace) the latest run of a command. */
export function recordRun(run: Omit<RunRecord, 'id'>): RunRecord {
  const res = getDb()
    .query<
      { id: number },
      [string, string, number, string, string | null, string | null, string | null, number, number]
    >(
      `INSERT INTO runs (command, args, exit_code, output, output_path, diagnostic_path, report_path, started_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(command) DO UPDATE SET
         args = excluded.args,
         exit_code = excluded.exit_code,
         output = excluded.output,
         output_path = excluded.output_path,
         diagnostic_path = excluded.diagnostic_path,
         report_path = excluded.report_path,
         started_at = excluded.started_at,
         duration_ms = excluded.duration_ms
       RETURNING id`,
    )
    .get(
      run.command,
      JSON.stringify(run.args),
      run.exitCode,
      run.output,
      run.outputPath ?? null,
      run.diagnosticPath ?? null,
      run.reportPath ?? null,
      run.startedAt,
      run.durationMs,
    );
  return { ...run, id: res?.id ?? 0 };
}

/** The latest run of each command, most recent first. */
export function listRuns(limit = 50): RunRecord[] {
  return getDb()
    .query<RunRow, [number]>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    .all(limit)
    .map(toRecord);
}

/** Copy a command's latest run into the archives. Returns null if it has none. */
export function archiveRun(command: string): ArchiveRecord | null {
  const conn = getDb();
  const row = conn.query<RunRow, [string]>('SELECT * FROM runs WHERE command = ?').get(command);
  if (!row) return null;
  const archivedAt = Date.now();
  const res = conn
    .query<
      { id: number },
      [string, string, number, string, string | null, string | null, string | null, number, number, number]
    >(
      `INSERT INTO archives (command, args, exit_code, output, output_path, diagnostic_path, report_path, started_at, duration_ms, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      row.command,
      row.args,
      row.exit_code,
      row.output,
      row.output_path,
      row.diagnostic_path,
      row.report_path,
      row.started_at,
      row.duration_ms,
      archivedAt,
    );
  return { ...toRecord(row), id: res?.id ?? 0, archivedAt };
}

/** All archived runs, most recently archived first. */
export function listArchives(limit = 200): ArchiveRecord[] {
  return getDb()
    .query<ArchiveRow, [number]>('SELECT * FROM archives ORDER BY archived_at DESC LIMIT ?')
    .all(limit)
    .map(toArchive);
}

/** Delete an archive by id. Returns true if a row was removed. */
export function deleteArchive(id: number): boolean {
  return getDb().query<{ id: number }, [number]>('DELETE FROM archives WHERE id = ? RETURNING id').get(id) != null;
}

// ── run history (append-only; every run kept, pruned per command) ────────────

/** Cap on history rows kept per command, so the table can't grow without bound. */
const HISTORY_PER_COMMAND = 50;

interface RunHistoryRow extends RunRow {
  source: string;
}

function toHistory(row: RunHistoryRow): RunHistoryRecord {
  return { ...toRecord(row), source: row.source === 'saved' ? 'saved' : 'builtin' };
}

/** Append a run to the history, then prune that command to the most recent N. */
export function recordRunHistory(run: Omit<RunHistoryRecord, 'id'>): RunHistoryRecord {
  const conn = getDb();
  const res = conn
    .query<
      { id: number },
      [string, string, number, string, string | null, string | null, string | null, number, number, string]
    >(
      `INSERT INTO run_history (command, args, exit_code, output, output_path, diagnostic_path, report_path, started_at, duration_ms, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      run.command,
      JSON.stringify(run.args),
      run.exitCode,
      run.output,
      run.outputPath ?? null,
      run.diagnosticPath ?? null,
      run.reportPath ?? null,
      run.startedAt,
      run.durationMs,
      run.source,
    );
  conn.run(
    `DELETE FROM run_history WHERE command = ? AND id NOT IN (
       SELECT id FROM run_history WHERE command = ? ORDER BY started_at DESC, id DESC LIMIT ?
     )`,
    [run.command, run.command, HISTORY_PER_COMMAND],
  );
  return { ...run, id: res?.id ?? 0 };
}

/** Run history, most recent first (optionally for a single command). */
export function listRunHistory(command?: string, limit = 100): RunHistoryRecord[] {
  const conn = getDb();
  const rows = command
    ? conn
        .query<RunHistoryRow, [string, number]>(
          'SELECT * FROM run_history WHERE command = ? ORDER BY started_at DESC, id DESC LIMIT ?',
        )
        .all(command, limit)
    : conn
        .query<RunHistoryRow, [number]>('SELECT * FROM run_history ORDER BY started_at DESC, id DESC LIMIT ?')
        .all(limit);
  return rows.map(toHistory);
}

// ── command run stats (run count + last run, for the Commands page sorts) ────

export type CommandStatScope = 'builtin' | 'saved';

export interface CommandStat {
  scope: CommandStatScope;
  /** Builtin command name, or a saved command's id. */
  key: string;
  runCount: number;
  lastRunAt?: number;
  lastExitCode?: number;
}

interface CommandStatRow {
  scope: string;
  key: string;
  run_count: number;
  last_run_at: number | null;
  last_exit_code: number | null;
}

/** Record one run against a command's stats (run count + last run/exit). */
export function bumpCommandStat(scope: CommandStatScope, key: string, exitCode: number, startedAt: number): void {
  getDb().run(
    `INSERT INTO command_stats (scope, key, run_count, last_run_at, last_exit_code)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET
       run_count = run_count + 1,
       last_run_at = excluded.last_run_at,
       last_exit_code = excluded.last_exit_code`,
    [scope, key, startedAt, exitCode],
  );
}

/** All command run stats (both scopes). The UI merges these onto each command. */
export function getCommandStats(): CommandStat[] {
  return getDb()
    .query<CommandStatRow, []>('SELECT * FROM command_stats')
    .all()
    .map((r) => ({
      scope: r.scope === 'saved' ? 'saved' : 'builtin',
      key: r.key,
      runCount: r.run_count,
      lastRunAt: r.last_run_at ?? undefined,
      lastExitCode: r.last_exit_code ?? undefined,
    }));
}

// ── saved commands (user-authored shell commands + saved invocations) ────────

interface SavedCommandRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  command: string;
  args: string;
  cwd: string | null;
  created_at: number;
  updated_at: number;
}

function toSavedCommand(r: SavedCommandRow): SavedCommand {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind === 'builtin' ? 'builtin' : 'shell',
    command: r.command,
    args: JSON.parse(r.args),
    cwd: r.cwd ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved commands, most-recently-updated first. */
export function listSavedCommands(limit = 200): SavedCommand[] {
  return getDb()
    .query<SavedCommandRow, [number]>('SELECT * FROM saved_commands ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSavedCommand);
}

export function getSavedCommand(id: string): SavedCommand | null {
  const row = getDb().query<SavedCommandRow, [string]>('SELECT * FROM saved_commands WHERE id = ?').get(id);
  return row ? toSavedCommand(row) : null;
}

/** Create (no id) or update (with id) a saved command. */
export function saveSavedCommand(input: SaveCommand): SavedCommand {
  const conn = getDb();
  const now = Date.now();
  const description = input.description ?? '';
  const args = JSON.stringify(input.args ?? []);
  const cwd = input.cwd?.trim() ? input.cwd.trim() : null;
  if (input.id) {
    const row = conn
      .query<SavedCommandRow, [string, string, string, string, string, string | null, number, string]>(
        `UPDATE saved_commands SET name = ?, description = ?, kind = ?, command = ?, args = ?, cwd = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(input.name, description, input.kind, input.command, args, cwd, now, input.id);
    if (row) return toSavedCommand(row);
  }
  const id = randomUUID();
  conn.run(
    `INSERT INTO saved_commands (id, name, description, kind, command, args, cwd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, description, input.kind, input.command, args, cwd, now, now],
  );
  return {
    id,
    name: input.name,
    description,
    kind: input.kind,
    command: input.command,
    args: input.args ?? [],
    cwd: cwd ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/** Delete a saved command by id. Returns true if a row was removed. */
export function deleteSavedCommand(id: string): boolean {
  const removed =
    getDb().query<{ id: string }, [string]>('DELETE FROM saved_commands WHERE id = ? RETURNING id').get(id) != null;
  // Drop its run stats too, so a future command reusing the id can't inherit them.
  if (removed) getDb().run('DELETE FROM command_stats WHERE scope = ? AND key = ?', ['saved', id]);
  return removed;
}

// ── automation runs (the Playwright builder) ────────────────────────────────

interface AutomationRunRow {
  id: number;
  automation: string;
  automation_id: string | null;
  correlation_id: string | null;
  status: string;
  steps: string;
  scraped: string;
  started_at: number;
  duration_ms: number;
}

function toAutomationRun(row: AutomationRunRow): AutomationRunRecord {
  return {
    id: row.id,
    automation: row.automation,
    automationId: row.automation_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    status: row.status as AutomationRunRecord['status'],
    steps: JSON.parse(row.steps),
    scraped: JSON.parse(row.scraped),
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  };
}

/** Record an automation run (append-only history). */
export function recordAutomationRun(run: Omit<AutomationRunRecord, 'id'>): AutomationRunRecord {
  const res = getDb()
    .query<{ id: number }, [string, string | null, string | null, string, string, string, number, number]>(
      `INSERT INTO automation_runs (automation, automation_id, correlation_id, status, steps, scraped, started_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      run.automation,
      run.automationId ?? null,
      run.correlationId ?? null,
      run.status,
      JSON.stringify(run.steps),
      JSON.stringify(run.scraped),
      run.startedAt,
      run.durationMs,
    );
  return { ...run, id: res?.id ?? 0 };
}

/** Fetch a single automation run by id (for locating its artifacts before delete). */
export function getAutomationRun(id: number): AutomationRunRecord | null {
  const row = getDb().query<AutomationRunRow, [number]>('SELECT * FROM automation_runs WHERE id = ?').get(id);
  return row ? toAutomationRun(row) : null;
}

/** Delete one automation run's DB row. Returns true if a row was removed. */
export function deleteAutomationRun(id: number): boolean {
  return (
    getDb().query<{ id: number }, [number]>('DELETE FROM automation_runs WHERE id = ? RETURNING id').get(id) != null
  );
}

/**
 * Delete automation run rows — all of them, or just one automation's — and return
 * the removed rows (so the caller can clean up each one's on-disk artifacts).
 */
export function deleteAutomationRuns(automation?: string): AutomationRunRecord[] {
  const conn = getDb();
  const rows = automation
    ? conn
        .query<AutomationRunRow, [string]>('DELETE FROM automation_runs WHERE automation = ? RETURNING *')
        .all(automation)
    : conn.query<AutomationRunRow, []>('DELETE FROM automation_runs RETURNING *').all();
  return rows.map(toAutomationRun);
}

/** Recent automation runs, most recent first (optionally for one automation). */
export function listAutomationRuns(automation?: string, limit = 50): AutomationRunRecord[] {
  const conn = getDb();
  const rows = automation
    ? conn
        .query<AutomationRunRow, [string, number]>(
          'SELECT * FROM automation_runs WHERE automation = ? ORDER BY started_at DESC LIMIT ?',
        )
        .all(automation, limit)
    : conn
        .query<AutomationRunRow, [number]>('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?')
        .all(limit);
  return rows.map(toAutomationRun);
}

// ── pipeline runs ────────────────────────────────────────────────────────────

interface PipelineRunRow {
  id: number;
  pipeline: string;
  status: string;
  stages: string;
  vars: string;
  dir: string;
  diagnostic_path: string | null;
  started_at: number;
  duration_ms: number;
}

function toPipelineRun(row: PipelineRunRow): PipelineRunRecord {
  return {
    id: row.id,
    pipeline: row.pipeline,
    status: row.status as PipelineRunRecord['status'],
    stages: JSON.parse(row.stages),
    vars: JSON.parse(row.vars),
    dir: row.dir,
    diagnosticPath: row.diagnostic_path ?? undefined,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  };
}

/** Record a pipeline run (append-only history). */
export function recordPipelineRun(run: Omit<PipelineRunRecord, 'id'>): PipelineRunRecord {
  const res = getDb()
    .query<{ id: number }, [string, string, string, string, string, string | null, number, number]>(
      `INSERT INTO pipeline_runs (pipeline, status, stages, vars, dir, diagnostic_path, started_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      run.pipeline,
      run.status,
      JSON.stringify(run.stages),
      JSON.stringify(run.vars),
      run.dir,
      run.diagnosticPath ?? null,
      run.startedAt,
      run.durationMs,
    );
  return { ...run, id: res?.id ?? 0 };
}

/** Recent pipeline runs, most recent first (optionally for one pipeline). */
export function listPipelineRuns(pipeline?: string, limit = 50): PipelineRunRecord[] {
  const conn = getDb();
  const rows = pipeline
    ? conn
        .query<PipelineRunRow, [string, number]>(
          'SELECT * FROM pipeline_runs WHERE pipeline = ? ORDER BY started_at DESC LIMIT ?',
        )
        .all(pipeline, limit)
    : conn.query<PipelineRunRow, [number]>('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?').all(limit);
  return rows.map(toPipelineRun);
}

// ── deploy verifications ─────────────────────────────────────────────────────

export interface DeployVerificationRecord {
  id: number;
  verifiedAt: number;
  listPath?: string;
  app: string;
  version: string;
  commitSha?: string;
  imageSha: string;
  status: 'PASS' | 'FAIL';
  issues: string[];
  warnings: string[];
  metadata: unknown;
}

interface DeployVerificationRow {
  id: number;
  verified_at: number;
  list_path: string | null;
  app: string;
  version: string;
  commit_sha: string | null;
  image_sha: string;
  status: string;
  issues: string;
  warnings: string;
  metadata: string;
}

function toDeployVerification(row: DeployVerificationRow): DeployVerificationRecord {
  return {
    id: row.id,
    verifiedAt: row.verified_at,
    listPath: row.list_path ?? undefined,
    app: row.app,
    version: row.version,
    commitSha: row.commit_sha ?? undefined,
    imageSha: row.image_sha,
    status: row.status as 'PASS' | 'FAIL',
    issues: JSON.parse(row.issues),
    warnings: JSON.parse(row.warnings),
    metadata: JSON.parse(row.metadata),
  };
}

/** Record one verified deploy-list entry (append-only history). */
export function recordVerification(rec: Omit<DeployVerificationRecord, 'id'>): DeployVerificationRecord {
  const res = getDb()
    .query<
      { id: number },
      [number, string | null, string, string, string | null, string, string, string, string, string]
    >(
      `INSERT INTO deploy_verifications
         (verified_at, list_path, app, version, commit_sha, image_sha, status, issues, warnings, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      rec.verifiedAt,
      rec.listPath ?? null,
      rec.app,
      rec.version,
      rec.commitSha ?? null,
      rec.imageSha,
      rec.status,
      JSON.stringify(rec.issues),
      JSON.stringify(rec.warnings),
      JSON.stringify(rec.metadata),
    );
  return { ...rec, id: res?.id ?? 0 };
}

/** Recent verification records, most recent first (optionally for one app). */
export function listVerifications(app?: string, limit = 100): DeployVerificationRecord[] {
  const conn = getDb();
  const rows = app
    ? conn
        .query<DeployVerificationRow, [string, number]>(
          'SELECT * FROM deploy_verifications WHERE app = ? ORDER BY verified_at DESC LIMIT ?',
        )
        .all(app, limit)
    : conn
        .query<DeployVerificationRow, [number]>('SELECT * FROM deploy_verifications ORDER BY verified_at DESC LIMIT ?')
        .all(limit);
  return rows.map(toDeployVerification);
}

// ── conversations + messages (ask about your repo) ───────────────────────────

interface ConversationRow {
  id: string;
  app: string;
  title: string | null;
  fs_root: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  thinking: string | null;
  tool_events: string | null;
  sources: string | null;
  model: string | null;
  trace: string | null;
  created_at: number;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    // General conversations are stored with an empty app; surface that as absent.
    app: row.app || undefined,
    title: row.title ?? undefined,
    fsRoot: row.fs_root ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as ChatRole,
    content: row.content,
    thinking: row.thinking ?? undefined,
    toolEvents: row.tool_events ? (JSON.parse(row.tool_events) as ToolEvent[]) : undefined,
    sources: row.sources ? (JSON.parse(row.sources) as AskSource[]) : undefined,
    model: row.model ?? undefined,
    trace: row.trace ? (JSON.parse(row.trace) as MessageTrace) : undefined,
    createdAt: row.created_at,
  };
}

/** Start a new conversation, scoped to an app or general (no app → stored empty).
 *  `fsRoot` binds a general conversation to a folder the AI may explore. */
export function createConversation(app?: string, fsRoot?: string): Conversation {
  const id = randomUUID();
  const now = Date.now();
  getDb().run(
    'INSERT INTO conversations (id, app, title, fs_root, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
    [id, app ?? '', fsRoot ?? null, now, now],
  );
  return { id, app: app || undefined, fsRoot: fsRoot || undefined, createdAt: now, updatedAt: now };
}

export function getConversation(id: string): Conversation | null {
  const row = getDb().query<ConversationRow, [string]>('SELECT * FROM conversations WHERE id = ?').get(id);
  return row ? toConversation(row) : null;
}

/** Conversations most-recently-updated first, optionally filtered to one app. */
export function listConversations(app?: string, limit = 100): Conversation[] {
  const conn = getDb();
  const rows = app
    ? conn
        .query<ConversationRow, [string, number]>(
          'SELECT * FROM conversations WHERE app = ? ORDER BY updated_at DESC LIMIT ?',
        )
        .all(app, limit)
    : conn.query<ConversationRow, [number]>('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit);
  return rows.map(toConversation);
}

export function getMessages(conversationId: string): ChatMessage[] {
  return getDb()
    .query<MessageRow, [string]>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, id')
    .all(conversationId)
    .map(toMessage);
}

/** Delete a conversation and its messages. Returns true if it existed. */
export function deleteConversation(id: string): boolean {
  const conn = getDb();
  conn.run('DELETE FROM messages WHERE conversation_id = ?', [id]);
  return conn.query<{ id: string }, [string]>('DELETE FROM conversations WHERE id = ? RETURNING id').get(id) != null;
}

export interface NewMessage {
  conversationId: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  toolEvents?: ToolEvent[];
  sources?: AskSource[];
  model?: string;
  trace?: MessageTrace;
  /** Pre-minted id (the server mints the assistant messageId before streaming). */
  id?: string;
}

/** Append a message and bump the conversation's updated_at. */
export function addMessage(m: NewMessage): ChatMessage {
  const id = m.id ?? randomUUID();
  const now = Date.now();
  const conn = getDb();
  conn.run(
    `INSERT INTO messages (id, conversation_id, role, content, thinking, tool_events, sources, model, trace, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      m.conversationId,
      m.role,
      m.content,
      m.thinking ?? null,
      m.toolEvents ? JSON.stringify(m.toolEvents) : null,
      m.sources ? JSON.stringify(m.sources) : null,
      m.model ?? null,
      m.trace ? JSON.stringify(m.trace) : null,
      now,
    ],
  );
  conn.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, m.conversationId]);
  return {
    id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    toolEvents: m.toolEvents,
    sources: m.sources,
    model: m.model,
    trace: m.trace,
    createdAt: now,
  };
}

/** Set a conversation's title (e.g. from a generated title or the first question). */
export function setConversationTitle(id: string, title: string): void {
  getDb().run('UPDATE conversations SET title = ? WHERE id = ?', [title, id]);
}

// ── saved tools (Tools tab: curl/fetch requests + regexes) ───────────────────

interface SavedCurlRow {
  id: string;
  name: string;
  request: string;
  created_at: number;
  updated_at: number;
}

function toSavedCurl(r: SavedCurlRow): SavedCurlRequest {
  return { id: r.id, name: r.name, request: JSON.parse(r.request), createdAt: r.created_at, updatedAt: r.updated_at };
}

/** Saved curl requests, most-recently-updated first. */
export function listSavedCurlRequests(limit = 200): SavedCurlRequest[] {
  return getDb()
    .query<SavedCurlRow, [number]>('SELECT * FROM saved_curl_requests ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSavedCurl);
}

/** Create (no id) or update (with id) a saved curl request. */
export function saveCurlRequest(input: SaveCurlRequest): SavedCurlRequest {
  const conn = getDb();
  const now = Date.now();
  const payload = JSON.stringify(input.request);
  if (input.id) {
    const row = conn
      .query<SavedCurlRow, [string, string, number, string]>(
        'UPDATE saved_curl_requests SET name = ?, request = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, payload, now, input.id);
    if (row) return toSavedCurl(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO saved_curl_requests (id, name, request, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.name,
    payload,
    now,
    now,
  ]);
  return { id, name: input.name, request: input.request, createdAt: now, updatedAt: now };
}

/** Delete a saved curl request by id. Returns true if a row was removed. */
export function deleteSavedCurlRequest(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM saved_curl_requests WHERE id = ? RETURNING id').get(id) != null
  );
}

interface SavedRegexRow {
  id: string;
  title: string;
  pattern: string;
  flags: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

function toSavedRegex(r: SavedRegexRow): SavedRegex {
  return {
    id: r.id,
    title: r.title,
    pattern: r.pattern,
    flags: r.flags,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved regexes, most-recently-updated first. */
export function listSavedRegexes(limit = 200): SavedRegex[] {
  return getDb()
    .query<SavedRegexRow, [number]>('SELECT * FROM saved_regexes ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSavedRegex);
}

/** Create (no id) or update (with id) a saved regex. */
export function saveRegex(input: SaveRegex): SavedRegex {
  const conn = getDb();
  const now = Date.now();
  const notes = input.notes ?? '';
  if (input.id) {
    const row = conn
      .query<SavedRegexRow, [string, string, string, string, number, string]>(
        'UPDATE saved_regexes SET title = ?, pattern = ?, flags = ?, notes = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.title, input.pattern, input.flags, notes, now, input.id);
    if (row) return toSavedRegex(row);
  }
  const id = randomUUID();
  conn.run(
    'INSERT INTO saved_regexes (id, title, pattern, flags, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, input.title, input.pattern, input.flags, notes, now, now],
  );
  return { id, title: input.title, pattern: input.pattern, flags: input.flags, notes, createdAt: now, updatedAt: now };
}

/** Delete a saved regex by id. Returns true if a row was removed. */
export function deleteSavedRegex(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM saved_regexes WHERE id = ? RETURNING id').get(id) != null;
}

interface SavedCronRow {
  id: string;
  title: string;
  expression: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

function toSavedCron(r: SavedCronRow): SavedCron {
  return {
    id: r.id,
    title: r.title,
    expression: r.expression,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved cron schedules, most-recently-updated first. */
export function listSavedCrons(limit = 200): SavedCron[] {
  return getDb()
    .query<SavedCronRow, [number]>('SELECT * FROM saved_crons ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSavedCron);
}

/** Create (no id) or update (with id) a saved cron schedule. */
export function saveCron(input: SaveCron): SavedCron {
  const conn = getDb();
  const now = Date.now();
  const notes = input.notes ?? '';
  if (input.id) {
    const row = conn
      .query<SavedCronRow, [string, string, string, number, string]>(
        'UPDATE saved_crons SET title = ?, expression = ?, notes = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.title, input.expression, notes, now, input.id);
    if (row) return toSavedCron(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO saved_crons (id, title, expression, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    input.title,
    input.expression,
    notes,
    now,
    now,
  ]);
  return { id, title: input.title, expression: input.expression, notes, createdAt: now, updatedAt: now };
}

/** Delete a saved cron by id. Returns true if a row was removed. */
export function deleteSavedCron(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM saved_crons WHERE id = ? RETURNING id').get(id) != null;
}

// ── request builder (saved HTTP requests + environments) ─────────────────────

interface HttpRequestRow {
  id: string;
  name: string;
  folder: string | null;
  request: string;
  created_at: number;
  updated_at: number;
}

function toSavedRequest(r: HttpRequestRow): SavedRequest {
  return {
    id: r.id,
    name: r.name,
    folder: r.folder ?? undefined,
    request: JSON.parse(r.request),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved requests, most-recently-updated first. */
export function listRequests(limit = 500): SavedRequest[] {
  return getDb()
    .query<HttpRequestRow, [number]>('SELECT * FROM http_requests ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSavedRequest);
}

/** Create (no id) or update (with id) a saved request. */
export function saveRequest(input: { id?: string; name: string; folder?: string; request: HttpRequest }): SavedRequest {
  const conn = getDb();
  const now = Date.now();
  const payload = JSON.stringify(input.request);
  if (input.id) {
    const row = conn
      .query<HttpRequestRow, [string, string | null, string, number, string]>(
        'UPDATE http_requests SET name = ?, folder = ?, request = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, input.folder ?? null, payload, now, input.id);
    if (row) return toSavedRequest(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO http_requests (id, name, folder, request, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    input.name,
    input.folder ?? null,
    payload,
    now,
    now,
  ]);
  return { id, name: input.name, folder: input.folder, request: input.request, createdAt: now, updatedAt: now };
}

/** Delete a saved request by id. Returns true if a row was removed. */
export function deleteRequest(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM http_requests WHERE id = ? RETURNING id').get(id) != null;
}

interface EnvironmentRow {
  id: string;
  name: string;
  variables: string;
  created_at: number;
  updated_at: number;
}

function toEnvironment(r: EnvironmentRow): Environment {
  return {
    id: r.id,
    name: r.name,
    variables: JSON.parse(r.variables),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Environments, most-recently-updated first. */
export function listEnvironments(limit = 200): Environment[] {
  return getDb()
    .query<EnvironmentRow, [number]>('SELECT * FROM http_environments ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toEnvironment);
}

/** Create (no id) or update (with id) an environment. */
export function saveEnvironment(input: {
  id?: string;
  name: string;
  variables: Environment['variables'];
}): Environment {
  const conn = getDb();
  const now = Date.now();
  const vars = JSON.stringify(input.variables);
  if (input.id) {
    const row = conn
      .query<EnvironmentRow, [string, string, number, string]>(
        'UPDATE http_environments SET name = ?, variables = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, vars, now, input.id);
    if (row) return toEnvironment(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO http_environments (id, name, variables, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.name,
    vars,
    now,
    now,
  ]);
  return { id, name: input.name, variables: input.variables, createdAt: now, updatedAt: now };
}

/** Delete an environment by id. Returns true if a row was removed. */
export function deleteEnvironment(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM http_environments WHERE id = ? RETURNING id').get(id) != null
  );
}

// ── Query-builder connections + saved queries (see shared/queryBuilder) ──────

interface DbConnectionRow {
  id: string;
  name: string;
  connection: string;
  created_at: number;
  updated_at: number;
}

function toDbConnection(r: DbConnectionRow): DbConnection {
  return {
    ...(JSON.parse(r.connection) as DbConnectionInput),
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved query-builder connections, most-recently-updated first. NO passwords live here. */
export function listDbConnections(limit = 200): DbConnection[] {
  return getDb()
    .query<DbConnectionRow, [number]>('SELECT * FROM db_connections ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toDbConnection);
}

export function getDbConnection(id: string): DbConnection | null {
  const row = getDb().query<DbConnectionRow, [string]>('SELECT * FROM db_connections WHERE id = ?').get(id);
  return row ? toDbConnection(row) : null;
}

/** Create (no id) or update (with id) a query-builder connection. */
export function saveDbConnection(input: DbConnectionInput & { id?: string }): DbConnection {
  const conn = getDb();
  const now = Date.now();
  const { id: _id, ...data } = input;
  const payload = JSON.stringify(data);
  if (input.id) {
    const row = conn
      .query<DbConnectionRow, [string, string, number, string]>(
        'UPDATE db_connections SET name = ?, connection = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, payload, now, input.id);
    if (row) return toDbConnection(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO db_connections (id, name, connection, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.name,
    payload,
    now,
    now,
  ]);
  return { ...data, id, createdAt: now, updatedAt: now };
}

/** Delete a query-builder connection by id. Returns true if a row was removed. */
export function deleteDbConnection(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM db_connections WHERE id = ? RETURNING id').get(id) != null
  );
}

interface SavedDbQueryRow {
  id: string;
  name: string;
  query: string;
  created_at: number;
  updated_at: number;
}

function toSavedDbQuery(r: SavedDbQueryRow): SavedDbQuery {
  return {
    ...(JSON.parse(r.query) as SavedDbQueryInput),
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved queries, most-recently-updated first. */
export function listSavedDbQueries(limit = 500): SavedDbQuery[] {
  return getDb()
    .query<SavedDbQueryRow, [number]>('SELECT * FROM db_saved_queries ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSavedDbQuery);
}

/** Create (no id) or update (with id) a saved query. */
export function saveSavedDbQuery(input: SavedDbQueryInput & { id?: string }): SavedDbQuery {
  const conn = getDb();
  const now = Date.now();
  const { id: _id, ...data } = input;
  const payload = JSON.stringify(data);
  if (input.id) {
    const row = conn
      .query<SavedDbQueryRow, [string, string, number, string]>(
        'UPDATE db_saved_queries SET name = ?, query = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, payload, now, input.id);
    if (row) return toSavedDbQuery(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO db_saved_queries (id, name, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.name,
    payload,
    now,
    now,
  ]);
  return { ...data, id, createdAt: now, updatedAt: now };
}

/** Delete a saved query by id. Returns true if a row was removed. */
export function deleteSavedDbQuery(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM db_saved_queries WHERE id = ? RETURNING id').get(id) != null
  );
}

// ── ServiceNow connections + saved requests (no secrets stored; see servicenowRoutes) ──

interface SnConnectionRow {
  id: string;
  name: string;
  connection: string;
  created_at: number;
  updated_at: number;
}

function toSnConnection(r: SnConnectionRow): SnConnection {
  return {
    ...(JSON.parse(r.connection) as SnConnectionInput),
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved ServiceNow connections, most-recently-updated first. NO secrets live here. */
export function listSnConnections(limit = 200): SnConnection[] {
  return getDb()
    .query<SnConnectionRow, [number]>('SELECT * FROM servicenow_connections ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSnConnection);
}

export function getSnConnection(id: string): SnConnection | null {
  const row = getDb().query<SnConnectionRow, [string]>('SELECT * FROM servicenow_connections WHERE id = ?').get(id);
  return row ? toSnConnection(row) : null;
}

/** Create (no id) or update (with id) a ServiceNow connection. */
export function saveSnConnection(input: SnConnectionInput & { id?: string }): SnConnection {
  const conn = getDb();
  const now = Date.now();
  const { id: _id, ...data } = input;
  const payload = JSON.stringify(data);
  if (input.id) {
    const row = conn
      .query<SnConnectionRow, [string, string, number, string]>(
        'UPDATE servicenow_connections SET name = ?, connection = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, payload, now, input.id);
    if (row) return toSnConnection(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO servicenow_connections (id, name, connection, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.name,
    payload,
    now,
    now,
  ]);
  return { ...data, id, createdAt: now, updatedAt: now };
}

/** Delete a ServiceNow connection by id. Returns true if a row was removed. */
export function deleteSnConnection(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM servicenow_connections WHERE id = ? RETURNING id').get(id) !=
    null
  );
}

interface SnRequestRow {
  id: string;
  name: string;
  request: string;
  created_at: number;
  updated_at: number;
}

function toSnSavedRequest(r: SnRequestRow): SnSavedRequest {
  return {
    ...(JSON.parse(r.request) as SnSavedRequestInput),
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved ServiceNow requests, most-recently-updated first. */
export function listSnRequests(limit = 500): SnSavedRequest[] {
  return getDb()
    .query<SnRequestRow, [number]>('SELECT * FROM servicenow_requests ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toSnSavedRequest);
}

/** Create (no id) or update (with id) a saved ServiceNow request. */
export function saveSnRequest(input: SnSavedRequestInput & { id?: string }): SnSavedRequest {
  const conn = getDb();
  const now = Date.now();
  const { id: _id, ...data } = input;
  const payload = JSON.stringify(data);
  if (input.id) {
    const row = conn
      .query<SnRequestRow, [string, string, number, string]>(
        'UPDATE servicenow_requests SET name = ?, request = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, payload, now, input.id);
    if (row) return toSnSavedRequest(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO servicenow_requests (id, name, request, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.name,
    payload,
    now,
    now,
  ]);
  return { ...data, id, createdAt: now, updatedAt: now };
}

/** Delete a saved ServiceNow request by id. Returns true if a row was removed. */
export function deleteSnRequest(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM servicenow_requests WHERE id = ? RETURNING id').get(id) != null
  );
}

// ── Board tasks (see shared/board) ────────────────────────────────────────────

interface BoardTaskRow {
  id: string;
  title: string;
  task: string;
  created_at: number;
  updated_at: number;
}

function toBoardTask(r: BoardTaskRow): BoardTask {
  return {
    ...(JSON.parse(r.task) as BoardTaskInput),
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Every board task; the UI groups by status and sorts by position. */
export function listBoardTasks(limit = 1000): BoardTask[] {
  return getDb()
    .query<BoardTaskRow, [number]>('SELECT * FROM board_tasks ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toBoardTask);
}

/** Create (no id) or update (with id) a board task. */
export function saveBoardTask(input: BoardTaskInput & { id?: string }): BoardTask {
  const conn = getDb();
  const now = Date.now();
  const { id: _id, ...data } = input;
  const payload = JSON.stringify(data);
  if (input.id) {
    const row = conn
      .query<BoardTaskRow, [string, string, number, string]>(
        'UPDATE board_tasks SET title = ?, task = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.title, payload, now, input.id);
    if (row) return toBoardTask(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO board_tasks (id, title, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    input.title,
    payload,
    now,
    now,
  ]);
  return { ...data, id, createdAt: now, updatedAt: now };
}

/** Delete a board task by id. Returns true if a row was removed. */
export function deleteBoardTask(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM board_tasks WHERE id = ? RETURNING id').get(id) != null;
}

// ── Links (bookmark / link manager; see shared/links) ─────────────────────────

interface LinkRow {
  id: string;
  url: string;
  title: string;
  description: string;
  notes: string;
  tags: string;
  folder: string;
  favicon: string;
  created_at: number;
  updated_at: number;
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toLink(r: LinkRow): LinkItem {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    description: r.description,
    notes: r.notes,
    tags: parseTags(r.tags),
    folder: r.folder,
    favicon: r.favicon,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const FAVICON_CAP = 100_000;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** Every saved link, newest-touched first. */
export function listLinks(limit = 5000): LinkItem[] {
  return getDb()
    .query<LinkRow, [number]>('SELECT * FROM links ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toLink);
}

/** Create a link. Throws (SQLite UNIQUE) when the url is already saved — the route maps that to 409. */
export function createLink(input: LinkItemInput): LinkItem {
  const url = str(input.url).trim();
  const now = Date.now();
  const id = randomUUID();
  // Hand-created links carry no favicon (only imports do); description/notes default blank.
  const row = getDb()
    .query<LinkRow, [string, string, string, string, string, string, string, number, number]>(
      `INSERT INTO links (id, url, title, description, notes, tags, folder, favicon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?) RETURNING *`,
    )
    .get(
      id,
      url,
      str(input.title).trim() || url,
      str(input.description),
      str(input.notes),
      JSON.stringify(cleanTags(input.tags)),
      str(input.folder),
      now,
      now,
    );
  // RETURNING always yields a row on a successful insert.
  return toLink(row as LinkRow);
}

/** Presence-based patch: only fields actually present in `patch` change. Returns null if the link is gone. */
export function updateLink(id: string, patch: LinkItemInput): LinkItem | null {
  const db = getDb();
  const existing = db.query<LinkRow, [string]>('SELECT * FROM links WHERE id = ?').get(id);
  if (!existing) return null;
  const has = (k: string) => Object.hasOwn(patch, k);
  const row = db
    .query<LinkRow, [string, string, string, string, string, string, number, string]>(
      `UPDATE links SET url = ?, title = ?, description = ?, notes = ?, tags = ?, folder = ?, updated_at = ?
       WHERE id = ? RETURNING *`,
    )
    .get(
      has('url') ? str(patch.url).trim() || existing.url : existing.url,
      has('title') ? str(patch.title) : existing.title,
      has('description') ? str(patch.description) : existing.description,
      has('notes') ? str(patch.notes) : existing.notes,
      has('tags') ? JSON.stringify(cleanTags(patch.tags)) : existing.tags,
      has('folder') ? str(patch.folder) : existing.folder,
      Date.now(),
      id,
    );
  return row ? toLink(row as LinkRow) : null;
}

/** Delete a link by id. Returns true if a row was removed. */
export function deleteLink(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM links WHERE id = ? RETURNING id').get(id) != null;
}

// ── Vault ────────────────────────────────────────────────────────────────────
// Storage only: this layer holds the encrypted item blob + the master-password
// hash/salt. All crypto, the master gate, and the unlock-token live in
// server/vaultRoutes.ts (the single-user sibling of cursedalchemy's /vault).

/** One encrypted vault item row (`data` is an `encryptSecret` payload). */
export interface VaultItemRow {
  id: string;
  data: string;
  created_at: number;
  updated_at: number;
}

/** The stored master-password hash + salt (the separate unlock gate). */
export interface VaultMaster {
  hash: string;
  salt: string;
}

// One singleton row holds the master credential — rubato is single-user, so
// there's no per-user scoping (unlike cursedalchemy's users.vault_master_hash).
const VAULT_META_ID = 'singleton';

/** The stored master-password hash + salt, or null if none is set yet. */
export function getVaultMaster(): VaultMaster | null {
  const row = getDb()
    .query<{ master_hash: string; master_salt: string }, [string]>(
      'SELECT master_hash, master_salt FROM vault_meta WHERE id = ?',
    )
    .get(VAULT_META_ID);
  return row ? { hash: row.master_hash, salt: row.master_salt } : null;
}

/** Set/replace the master-password hash + salt. Items are unaffected (they're
 * encrypted under a server-held key, not this password). */
export function saveVaultMaster(hash: string, salt: string): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO vault_meta (id, master_hash, master_salt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET master_hash = excluded.master_hash,
         master_salt = excluded.master_salt, updated_at = excluded.updated_at`,
    )
    .run(VAULT_META_ID, hash, salt, now, now);
}

/** How many vault items exist (safe to report behind the locked UI — count only). */
export function countVaultItems(): number {
  return getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM vault_items').get()?.n ?? 0;
}

/** Every encrypted item row, newest-touched first. */
export function listVaultRows(): VaultItemRow[] {
  return getDb()
    .query<VaultItemRow, []>('SELECT id, data, created_at, updated_at FROM vault_items ORDER BY updated_at DESC')
    .all();
}

/** Insert an encrypted item; returns its id + timestamps. */
export function insertVaultRow(data: string): { id: string; createdAt: number; updatedAt: number } {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .query('INSERT INTO vault_items (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, data, now, now);
  return { id, createdAt: now, updatedAt: now };
}

/** Replace an item's encrypted blob; returns the new updatedAt, or null if gone. */
export function updateVaultRow(id: string, data: string): { updatedAt: number } | null {
  const now = Date.now();
  const row = getDb()
    .query<{ id: string }, [string, number, string]>(
      'UPDATE vault_items SET data = ?, updated_at = ? WHERE id = ? RETURNING id',
    )
    .get(data, now, id);
  return row ? { updatedAt: now } : null;
}

/** Delete a vault item by id. Returns true if a row was removed. */
export function deleteVaultRow(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM vault_items WHERE id = ? RETURNING id').get(id) != null;
}

/** A bookmark to import — the importable subset of cwip's `ParsedBookmark`. */
export interface LinkImportItem {
  url: string;
  title: string;
  folder: string;
  favicon: string;
}

/**
 * Bulk-import bookmarks, skipping any url already saved (so re-importing is safe).
 * Each imported link is tagged "imported"; the bookmark's folder path is kept.
 */
export function importLinks(items: LinkImportItem[]): LinkImportResult {
  const db = getDb();
  // Columns: id, url, title, description, notes, tags, folder, favicon, created_at, updated_at.
  // description + notes are left blank for imports; the rest are bound.
  const insert = db.query(
    `INSERT OR IGNORE INTO links (id, url, title, description, notes, tags, folder, favicon, created_at, updated_at)
     VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?)`,
  );
  const tags = JSON.stringify(['imported']);
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  db.transaction(() => {
    for (const b of items) {
      const url = b.url.trim();
      if (!url || seen.has(url)) {
        skipped++;
        continue;
      }
      seen.add(url);
      const now = Date.now();
      const res = insert.run(randomUUID(), url, b.title, tags, b.folder, b.favicon.slice(0, FAVICON_CAP), now, now);
      if (res.changes > 0) imported++;
      else skipped++; // url already existed (UNIQUE) → ignored
    }
  })();
  return { imported, skipped, total: items.length };
}

// ── Custom Pages (user-built dashboards; see shared/customPage) ───────────────

interface CustomPageRow {
  id: string;
  title: string;
  data: string;
  created_at: number;
  updated_at: number;
}

function toCustomPage(r: CustomPageRow): CustomPage {
  return {
    ...(JSON.parse(r.data) as Omit<CustomPageInput, 'title'>),
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Every custom page, most-recently-updated first. */
export function listCustomPages(limit = 1000): CustomPage[] {
  return getDb()
    .query<CustomPageRow, [number]>('SELECT * FROM custom_pages ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toCustomPage);
}

/** Create (no id) or update (with id) a custom page. */
export function saveCustomPage(input: CustomPageInput & { id?: string }): CustomPage {
  const conn = getDb();
  const now = Date.now();
  const { id: _id, title, ...rest } = input;
  const payload = JSON.stringify(rest);
  if (input.id) {
    const row = conn
      .query<CustomPageRow, [string, string, number, string]>(
        'UPDATE custom_pages SET title = ?, data = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(title, payload, now, input.id);
    if (row) return toCustomPage(row);
  }
  const id = randomUUID();
  conn.run('INSERT INTO custom_pages (id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    title,
    payload,
    now,
    now,
  ]);
  return { ...rest, title, id, createdAt: now, updatedAt: now };
}

/** Delete a custom page by id. Returns true if a row was removed. */
export function deleteCustomPage(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM custom_pages WHERE id = ? RETURNING id').get(id) != null;
}

// ── App vulnerabilities (security-scan stats) ────────────────────────────────

interface VulnRow {
  id: number;
  app: string;
  scan_type: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
  total: number;
  issue_types: string | null;
  source_file: string | null;
  report_name: string | null;
  linked_app: string | null;
  raw: string | null;
  scanned_at: number;
}

function toVulnRecord(row: VulnRow): VulnerabilityRecord {
  const issueTypes = row.issue_types ? safeParse(row.issue_types) : undefined;
  return {
    id: row.id,
    app: row.app,
    scanType: row.scan_type,
    critical: row.critical,
    high: row.high,
    medium: row.medium,
    low: row.low,
    informational: row.informational ?? 0,
    total: row.total,
    issueTypes: Array.isArray(issueTypes) ? (issueTypes as VulnerabilityRecord['issueTypes']) : undefined,
    sourceFile: row.source_file ?? undefined,
    reportName: row.report_name ?? undefined,
    linkedApp: row.linked_app ?? undefined,
    raw: row.raw ? safeParse(row.raw) : undefined,
    scannedAt: row.scanned_at,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Upsert a scan result, replacing the prior record for the same (app, scan_type). */
export function upsertVulnerability(input: VulnerabilityInput): VulnerabilityRecord {
  const critical = input.critical ?? 0;
  const high = input.high ?? 0;
  const medium = input.medium ?? 0;
  const low = input.low ?? 0;
  const informational = input.informational ?? 0;
  const total = critical + high + medium + low + informational;
  const scanType = input.scanType ?? '';
  const scannedAt = input.scannedAt ?? Date.now();
  const raw = input.raw === undefined ? null : JSON.stringify(input.raw);
  const issueTypes = input.issueTypes?.length ? JSON.stringify(input.issueTypes) : null;
  const row = getDb()
    .query<
      VulnRow,
      [
        string,
        string,
        number,
        number,
        number,
        number,
        number,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
      ]
    >(
      `INSERT INTO app_vulnerabilities
         (app, scan_type, critical, high, medium, low, informational, total, issue_types, source_file, report_name, linked_app, raw, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app, scan_type) DO UPDATE SET
         critical = excluded.critical, high = excluded.high, medium = excluded.medium, low = excluded.low,
         informational = excluded.informational, total = excluded.total, issue_types = excluded.issue_types,
         source_file = excluded.source_file,
         -- keep an existing stored report / app association when this upsert doesn't carry a new one
         report_name = COALESCE(excluded.report_name, app_vulnerabilities.report_name),
         linked_app = COALESCE(excluded.linked_app, app_vulnerabilities.linked_app),
         raw = excluded.raw, scanned_at = excluded.scanned_at
       RETURNING *`,
    )
    .get(
      input.app,
      scanType,
      critical,
      high,
      medium,
      low,
      informational,
      total,
      issueTypes,
      input.sourceFile ?? null,
      input.reportName ?? null,
      input.linkedApp ?? null,
      raw,
      scannedAt,
    );
  if (!row) throw new Error('failed to upsert vulnerability record');
  return toVulnRecord(row);
}

/**
 * Set (or clear, with `null`) the registry app a scan is associated with. Unlike
 * the COALESCE in `upsertVulnerability` (which preserves a link across re-imports),
 * this writes the value verbatim so the UI can also clear it. Returns the updated
 * record, or null when no row exists for that (app, scan_type).
 */
export function setVulnerabilityLink(
  app: string,
  scanType: string,
  linkedApp: string | null,
): VulnerabilityRecord | null {
  const row = getDb()
    .query<VulnRow, [string | null, string, string]>(
      'UPDATE app_vulnerabilities SET linked_app = ? WHERE app = ? AND scan_type = ? RETURNING *',
    )
    .get(linkedApp, app, scanType);
  return row ? toVulnRecord(row) : null;
}

/** The stored report file name for one (app, scan_type), if a PDF was imported. */
export function getVulnerabilityReportName(app: string, scanType = ''): string | null {
  const row = getDb()
    .query<{ report_name: string | null }, [string, string]>(
      'SELECT report_name FROM app_vulnerabilities WHERE app = ? AND scan_type = ?',
    )
    .get(app, scanType);
  return row?.report_name ?? null;
}

/** All stored scan records, most-recent first. */
export function listVulnerabilities(): VulnerabilityRecord[] {
  return getDb()
    .query<VulnRow, []>('SELECT * FROM app_vulnerabilities ORDER BY scanned_at DESC, app ASC')
    .all()
    .map(toVulnRecord);
}

/** Delete the record for one (app, scan_type). Returns true if a row was removed. */
export function deleteVulnerability(app: string, scanType = ''): boolean {
  return (
    getDb()
      .query<{ id: number }, [string, string]>(
        'DELETE FROM app_vulnerabilities WHERE app = ? AND scan_type = ? RETURNING id',
      )
      .get(app, scanType) != null
  );
}

/** Clear every stored vulnerability record. */
export function clearVulnerabilities(): void {
  getDb().run('DELETE FROM app_vulnerabilities');
}

// ── AI remediation plans (Markdown docs; view/edit/export) ──

interface PlanRow {
  id: string;
  title: string;
  app: string | null;
  source: string | null;
  content: string;
  created_at: number;
  updated_at: number;
}

function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    title: r.title,
    app: r.app,
    source: r.source,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved remediation plans, most-recently-updated first. */
export function listPlans(limit = 500): Plan[] {
  return getDb()
    .query<PlanRow, [number]>('SELECT * FROM remediation_plans ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toPlan);
}

export function getPlan(id: string): Plan | null {
  const row = getDb().query<PlanRow, [string]>('SELECT * FROM remediation_plans WHERE id = ?').get(id);
  return row ? toPlan(row) : null;
}

/** Create (no id) or update (with id) a remediation plan. */
export function savePlan(input: PlanInput & { id?: string }): Plan {
  const conn = getDb();
  const now = Date.now();
  if (input.id) {
    const row = conn
      .query<PlanRow, [string, string | null, string | null, string, number, string]>(
        'UPDATE remediation_plans SET title = ?, app = ?, source = ?, content = ?, updated_at = ? WHERE id = ? RETURNING *',
      )
      .get(input.title, input.app ?? null, input.source ?? null, input.content, now, input.id);
    if (row) return toPlan(row);
  }
  const id = randomUUID();
  conn.run(
    'INSERT INTO remediation_plans (id, title, app, source, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, input.title, input.app ?? null, input.source ?? null, input.content, now, now],
  );
  return {
    id,
    title: input.title,
    app: input.app ?? null,
    source: input.source ?? null,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  };
}

/** Delete a remediation plan by id. Returns true if a row was removed. */
export function deletePlan(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM remediation_plans WHERE id = ? RETURNING id').get(id) != null
  );
}

// ── orchestration timings (per-category work-timing analytics) ───────────────
// One row per orchlog event, ingested from `timing-*.jsonl`. Stored so the JSONL
// can be deleted later while the analytics persist. Rows map back to cwip's
// canonical `TimingEvent` so the shared aggregators (`aggregateByCategory` /
// `summarize`) are the single source of truth for the math.

interface OrchTimingRow {
  event_id: string;
  session: string | null;
  worker: string | null;
  task_id: string | null;
  task_title: string | null;
  repo: string | null;
  category: string;
  category_group: string | null;
  kind: string | null;
  command: string | null;
  exit_code: number | null;
  ok: number | null;
  note: string | null;
  start_iso: string | null;
  end_iso: string | null;
  duration_ms: number;
  ts: number;
  source_file: string | null;
  ingested_at: number;
}

/** Map a DB row back to a cwip `TimingEvent` (the shape the aggregators consume). */
function toTimingEvent(r: OrchTimingRow): TimingEvent {
  const category = isCategoryKey(r.category) ? r.category : 'other';
  return {
    schema: 'orchlog/v1',
    event_id: r.event_id,
    session: r.session ?? '',
    worker: r.worker ?? '',
    task_id: r.task_id ?? '',
    task_title: r.task_title ?? '',
    repo: r.repo ?? 'unknown',
    category,
    group: groupOf(category),
    kind: (r.kind as TimingEvent['kind']) ?? 'mark',
    command: r.command ?? undefined,
    exit_code: r.exit_code ?? undefined,
    ok: r.ok == null ? true : r.ok !== 0,
    note: r.note ?? undefined,
    start: r.start_iso ?? '',
    end: r.end_iso ?? '',
    duration_ms: r.duration_ms,
    ts: r.ts,
  };
}

/** A source `timing-*.jsonl` file the rows came from, with its ingested count. */
export interface OrchTimingSource {
  file: string;
  count: number;
}

/**
 * Idempotently insert a batch of parsed timing events from one source file.
 * `INSERT OR IGNORE` by `event_id` means re-ingesting the same file is a no-op —
 * already-stored events are skipped, new ones inserted. Returns insert/skip counts.
 */
export function insertTimingEvents(events: TimingEvent[], sourceFile: string): { inserted: number; skipped: number } {
  if (!events.length) return { inserted: 0, skipped: 0 };
  const conn = getDb();
  const now = Date.now();
  const stmt = conn.query<
    { event_id: string },
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      number | null,
      number,
      string | null,
      string,
      string,
      number,
      number,
      string,
      number,
    ]
  >(
    `INSERT OR IGNORE INTO orchestration_timings
       (event_id, session, worker, task_id, task_title, repo, category, category_group, kind,
        command, exit_code, ok, note, start_iso, end_iso, duration_ms, ts, source_file, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING event_id`,
  );
  let inserted = 0;
  const insertAll = conn.transaction((rows: TimingEvent[]) => {
    for (const ev of rows) {
      // An event with no stable id can't be deduped — skip it rather than letting a
      // blank PK collapse the whole batch into one row.
      if (!ev.event_id) continue;
      const res = stmt.get(
        ev.event_id,
        ev.session,
        ev.worker,
        ev.task_id,
        ev.task_title,
        ev.repo,
        ev.category,
        ev.group,
        ev.kind,
        ev.command ?? null,
        ev.exit_code ?? null,
        ev.ok ? 1 : 0,
        ev.note ?? null,
        ev.start,
        ev.end,
        ev.duration_ms,
        ev.ts,
        sourceFile,
        now,
      );
      if (res) inserted += 1;
    }
  });
  insertAll(events);
  return { inserted, skipped: events.filter((e) => e.event_id).length - inserted };
}

/** Filters for a timings query (all optional; epoch-ms bounds + canonical repo). */
export interface TimingQuery {
  /** Inclusive lower bound on `ts` (epoch ms). */
  from?: number;
  /** Inclusive upper bound on `ts` (epoch ms). */
  to?: number;
  /** Canonical repo (cursedalchemy | rubato | cwip | …); omit/`all` for every repo. */
  repo?: string;
}

/** Load filtered timing rows as cwip `TimingEvent[]`, oldest→newest by `ts`. */
export function listTimingEvents(q: TimingQuery = {}): TimingEvent[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (typeof q.from === 'number' && Number.isFinite(q.from)) {
    where.push('ts >= ?');
    params.push(q.from);
  }
  if (typeof q.to === 'number' && Number.isFinite(q.to)) {
    where.push('ts <= ?');
    params.push(q.to);
  }
  if (q.repo && q.repo !== 'all') {
    where.push('repo = ?');
    params.push(q.repo);
  }
  const sql = `SELECT * FROM orchestration_timings${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts ASC`;
  return getDb()
    .query<OrchTimingRow, (number | string)[]>(sql)
    .all(...params)
    .map(toTimingEvent);
}

/**
 * Load filtered timing rows for the table view — newest first, capped at `limit` —
 * carrying the per-row `source_file` (which `TimingEvent` doesn't model) so the page
 * can deep-link each row to its source. Same filters as `listTimingEvents`.
 */
export function listTimingRows(q: TimingQuery = {}, limit = 500): TimingTableRow[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (typeof q.from === 'number' && Number.isFinite(q.from)) {
    where.push('ts >= ?');
    params.push(q.from);
  }
  if (typeof q.to === 'number' && Number.isFinite(q.to)) {
    where.push('ts <= ?');
    params.push(q.to);
  }
  if (q.repo && q.repo !== 'all') {
    where.push('repo = ?');
    params.push(q.repo);
  }
  const sql = `SELECT * FROM orchestration_timings${
    where.length ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY ts DESC LIMIT ?`;
  return getDb()
    .query<OrchTimingRow, (number | string)[]>(sql)
    .all(...params, limit)
    .map((r) => {
      const category = isCategoryKey(r.category) ? r.category : 'other';
      return {
        eventId: r.event_id,
        session: r.session ?? '',
        worker: r.worker ?? '',
        taskId: r.task_id ?? '',
        taskTitle: r.task_title ?? '',
        repo: r.repo ?? 'unknown',
        category,
        group: r.category_group ?? groupOf(category),
        kind: r.kind ?? 'mark',
        command: r.command ?? undefined,
        exitCode: r.exit_code ?? undefined,
        ok: r.ok == null ? true : r.ok !== 0,
        note: r.note ?? undefined,
        start: r.start_iso ?? '',
        end: r.end_iso ?? '',
        durationMs: r.duration_ms,
        ts: r.ts,
        sourceFile: r.source_file ?? undefined,
      };
    });
}

/** A table row with its category as a string + the per-row source file. */
export interface TimingTableRow {
  eventId: string;
  session: string;
  worker: string;
  taskId: string;
  taskTitle: string;
  repo: string;
  category: string;
  group: string;
  kind: string;
  command?: string;
  exitCode?: number;
  ok: boolean;
  note?: string;
  start: string;
  end: string;
  durationMs: number;
  ts: number;
  sourceFile?: string;
}

/**
 * Load timing events within an explicit ms time window (for per-history-entry breakdown).
 * Same mapping as `listTimingEvents` but filters by `ts BETWEEN from AND to`.
 */
export function listTimingEventsInWindow(from: number, to: number, repo?: string): TimingEvent[] {
  const where: string[] = ['ts >= ?', 'ts <= ?'];
  const params: (number | string)[] = [from, to];
  if (repo && repo !== 'all') {
    where.push('repo = ?');
    params.push(repo);
  }
  const sql = `SELECT * FROM orchestration_timings WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
  return getDb()
    .query<OrchTimingRow, (number | string)[]>(sql)
    .all(...params)
    .map(toTimingEvent);
}

/** Per-source-file ingested counts (for the page's "synced files" list). */
export function listTimingSources(): OrchTimingSource[] {
  return getDb()
    .query<{ source_file: string | null; count: number }, []>(
      'SELECT source_file, COUNT(*) AS count FROM orchestration_timings GROUP BY source_file ORDER BY count DESC',
    )
    .all()
    .map((r) => ({ file: r.source_file ?? '(unknown)', count: r.count }));
}

/** Distinct repos present in the stored timings (for the repo filter dropdown). */
export function listTimingRepos(): string[] {
  return getDb()
    .query<{ repo: string | null }, []>(
      "SELECT DISTINCT repo FROM orchestration_timings WHERE repo IS NOT NULL AND repo != '' ORDER BY repo",
    )
    .all()
    .map((r) => r.repo as string);
}

/**
 * Delete stored timings — all of them, or only those with `ts < before` (epoch ms)
 * so older data stops affecting the stats. Returns how many rows were removed.
 */
export function clearTimings(before?: number): number {
  const conn = getDb();
  if (typeof before === 'number' && Number.isFinite(before)) {
    return conn
      .query<{ n: number }, [number]>('DELETE FROM orchestration_timings WHERE ts < ? RETURNING ts')
      .all(before).length;
  }
  return conn.query<{ ts: number }, []>('DELETE FROM orchestration_timings RETURNING ts').all().length;
}

// ── Shell aliases ─────────────────────────────────────────────────────────────

interface ShellAliasRow {
  id: string;
  name: string;
  command: string;
  description: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface ShellAlias {
  id: string;
  name: string;
  command: string;
  description: string;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShellAliasInput {
  name: string;
  command?: string;
  description?: string;
  tags?: string;
}

function toShellAlias(r: ShellAliasRow): ShellAlias {
  return {
    id: r.id,
    name: r.name,
    command: r.command,
    description: r.description,
    tags: r.tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listShellAliases(): ShellAlias[] {
  return getDb().query<ShellAliasRow, []>('SELECT * FROM shell_aliases ORDER BY name ASC').all().map(toShellAlias);
}

export function createShellAlias(input: ShellAliasInput): ShellAlias {
  const now = new Date().toISOString();
  const id = randomUUID();
  const row = getDb()
    .query<ShellAliasRow, [string, string, string, string, string, string, string]>(
      `INSERT INTO shell_aliases (id, name, command, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(id, input.name, input.command ?? '', input.description ?? '', input.tags ?? '', now, now);
  return toShellAlias(row as ShellAliasRow);
}

export function updateShellAlias(id: string, patch: Partial<ShellAliasInput>): ShellAlias | null {
  const db = getDb();
  const ex = db.query<ShellAliasRow, [string]>('SELECT * FROM shell_aliases WHERE id = ?').get(id);
  if (!ex) return null;
  const has = (k: string) => Object.hasOwn(patch, k);
  const row = db
    .query<ShellAliasRow, [string, string, string, string, string, string]>(
      `UPDATE shell_aliases SET name=?, command=?, description=?, tags=?, updated_at=? WHERE id=? RETURNING *`,
    )
    .get(
      has('name') ? (patch.name ?? ex.name) : ex.name,
      has('command') ? (patch.command ?? ex.command) : ex.command,
      has('description') ? (patch.description ?? ex.description) : ex.description,
      has('tags') ? (patch.tags ?? ex.tags) : ex.tags,
      new Date().toISOString(),
      id,
    );
  return row ? toShellAlias(row as ShellAliasRow) : null;
}

export function deleteShellAlias(id: string): boolean {
  return getDb().query<{ id: string }, [string]>('DELETE FROM shell_aliases WHERE id = ? RETURNING id').get(id) != null;
}

/** Import aliases from a JSON export (from cursedalchemy). Returns how many were added. */
export function importShellAliases(aliases: { name: string; command: string; description?: string; tags?: string }[]): {
  imported: number;
  skipped: number;
} {
  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const a of aliases) {
    if (!a.name?.trim() || !a.command?.trim()) {
      skipped++;
      continue;
    }
    const exists = db.query<{ id: string }, [string]>('SELECT id FROM shell_aliases WHERE name = ?').get(a.name.trim());
    if (exists) {
      skipped++;
      continue;
    }
    const id = randomUUID();
    db.query(
      'INSERT INTO shell_aliases (id, name, command, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, a.name.trim(), a.command, a.description ?? '', a.tags ?? '', now, now);
    imported++;
  }
  return { imported, skipped };
}

// ── Automation environments (Postman-style named variable sets for automation runs) ──

interface AutomationEnvRow {
  id: string;
  name: string;
  variables: string;
  created_at: number;
  updated_at: number;
}

function toAutoEnv(row: AutomationEnvRow): AutomationEnvironment {
  return {
    id: row.id,
    name: row.name,
    variables: JSON.parse(row.variables) as EnvVar[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAutomationEnvironments(): AutomationEnvironment[] {
  return getDb()
    .query<AutomationEnvRow, []>('SELECT * FROM automation_environments ORDER BY name ASC')
    .all()
    .map(toAutoEnv);
}

export function saveAutomationEnvironment(input: {
  id?: string;
  name: string;
  variables?: EnvVar[];
}): AutomationEnvironment {
  const db = getDb();
  const now = Date.now();
  const id = input.id ?? randomUUID();
  const vars = JSON.stringify(input.variables ?? []);
  db.query(
    `INSERT INTO automation_environments (id, name, variables, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, variables=excluded.variables, updated_at=excluded.updated_at`,
  ).run(id, input.name, vars, now, now);
  return toAutoEnv(db.query<AutomationEnvRow, [string]>('SELECT * FROM automation_environments WHERE id = ?').get(id)!);
}

export function deleteAutomationEnvironment(id: string): boolean {
  return (
    getDb().query<{ id: string }, [string]>('DELETE FROM automation_environments WHERE id = ? RETURNING id').get(id) !=
    null
  );
}
