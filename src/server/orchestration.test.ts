import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createTask,
  defaultNotesDir,
  deleteTask,
  getOverview,
  listFiles,
  notesDir,
  readFileDoc,
  updateTask,
  writeFileDoc,
} from './orchestration';

// Isolate the notes dir (RUBATO_NOTES_DIR) AND the claude config dir
// (CLAUDE_CONFIG_DIR) to temp dirs so we read/write real files without touching
// the user's actual ~/code/workspaces or ~/.claude.
let dir: string;
let claude: string;
const prevNotes = process.env.RUBATO_NOTES_DIR;
const prevClaude = process.env.CLAUDE_CONFIG_DIR;

const SAMPLE_TASKS = `# TASKS

---
## [ ] rubato — a ready task
do the thing

## [x] (2026-06-14T18:00:00Z → 2026-06-14T18:09:00Z · 9m · rubato abc1234) rubato — a done task
landed.
`;

const SAMPLE_HISTORY = `# Tasks Completed

## rubato — first done task — Claude
- Started: 2026-06-13T19:00:00.000Z · Completed: 2026-06-13T19:30:00.000Z · Duration: 30m 0s
- Landed rubato main abc1234.
`;

const SAMPLE_RUN = `${JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'done',
  session_id: 'sess-1',
  model: 'claude-opus-4-8',
  total_cost_usd: 0.5,
  duration_ms: 60_000,
  input_tokens: 100,
  output_tokens: 200,
})}\n`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rubato-orch-'));
  claude = await mkdtemp(join(tmpdir(), 'rubato-orch-claude-'));
  process.env.RUBATO_NOTES_DIR = dir;
  process.env.CLAUDE_CONFIG_DIR = claude;
});

afterEach(async () => {
  if (prevNotes === undefined) delete process.env.RUBATO_NOTES_DIR;
  else process.env.RUBATO_NOTES_DIR = prevNotes;
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  await rm(dir, { recursive: true, force: true });
  await rm(claude, { recursive: true, force: true });
});

describe('notesDir resolution', () => {
  test('RUBATO_NOTES_DIR wins', async () => {
    expect(await notesDir()).toBe(resolve(dir));
  });

  test('defaults to the agent-workspace dir when nothing is set', () => {
    // The derived default is the agents' operational folder (home-relative).
    expect(defaultNotesDir()).toBe(resolve(homedir(), 'code', 'workspaces', '___Agent_Workspace'));
  });
});

describe('getOverview', () => {
  test('parses board + history + runs + stats from the notes dir', async () => {
    await writeFile(join(dir, 'TASKS.md'), SAMPLE_TASKS);
    await writeFile(join(dir, 'Tasks_Completed.md'), SAMPLE_HISTORY);
    await mkdir(join(dir, 'orchestration', 'runs'), { recursive: true });
    await writeFile(join(dir, 'orchestration', 'runs', 'run-1.jsonl'), SAMPLE_RUN);

    const ov = await getOverview();
    expect(ov.notesDirExists).toBe(true);
    expect(ov.board.counts.ready).toBe(1);
    expect(ov.board.counts.done).toBe(1);
    expect(ov.history).toHaveLength(1);
    expect(ov.history[0].repo).toBe('rubato');
    expect(ov.runs.hasRuns).toBe(true);
    expect(ov.runs.totalRuns).toBe(1);
    expect(ov.runs.recent[0].sessionId).toBe('sess-1');
    expect(ov.stats.totalTasks).toBe(1);
    expect(ov.stats.totalDurationSeconds).toBe(30 * 60);
    expect(ov.stats.totalCostUsd).toBe(0.5);
    expect(ov.stats.byRepo[0].repo).toBe('rubato');
  });

  test('empty when nothing exists (no crash on missing files/dirs)', async () => {
    const ov = await getOverview();
    expect(ov.board.total).toBe(0);
    expect(ov.history).toHaveLength(0);
    expect(ov.runs.hasRuns).toBe(false);
    expect(ov.stats.totalTasks).toBe(0);
  });

  test('flags a missing notes dir', async () => {
    process.env.RUBATO_NOTES_DIR = join(dir, 'does-not-exist');
    const ov = await getOverview();
    expect(ov.notesDirExists).toBe(false);
    expect(ov.board.total).toBe(0);
  });
});

describe('file allowlist (read/write)', () => {
  test('lists the editable files with existence + canonical path', async () => {
    await writeFile(join(dir, 'TASKS.md'), SAMPLE_TASKS);
    const files = await listFiles();
    const tasks = files.find((f) => f.key === 'tasks');
    expect(tasks).toBeDefined();
    expect(tasks?.exists).toBe(true);
    expect(tasks?.markdown).toBe(true);
    // The path resolves under the (canonicalized) notes dir.
    expect(tasks?.path.endsWith('TASKS.md')).toBe(true);
    // The claude-config files are listed too.
    for (const key of ['claude-md', 'loop', 'next-task', 'auto-run-settings', 'drain-queue']) {
      expect(files.some((f) => f.key === key)).toBe(true);
    }
  });

  test('findings note resolves under ___Workspace_Notes, NOT the (relocated) notes dir', async () => {
    // The notes dir is the isolated temp dir; the findings note has its own base
    // (~/code/workspaces/___Workspace_Notes), so it must NOT resolve under `dir`.
    const findings = (await listFiles()).find((f) => f.key === 'findings');
    expect(findings).toBeDefined();
    // It lives under the Saved_Instance_Docs/ subdir of the workspace-notes base.
    expect(findings?.path.endsWith(join('Saved_Instance_Docs', 'Agent_Workflow_Optimization_Findings.md'))).toBe(true);
    expect(findings?.path.includes('___Workspace_Notes')).toBe(true);
    expect(findings?.path.startsWith(resolve(dir))).toBe(false);
  });

  test('reads not-exists with empty content when absent', async () => {
    const doc = await readFileDoc('loop');
    expect(doc?.exists).toBe(false);
    expect(doc?.content).toBe('');
  });

  test('roundtrip: write (creating the file + parent dir), then read it back', async () => {
    // `next-task` lives under <claude>/commands/, which doesn't exist yet — the
    // write must create the parent dir too (via the canonical-path machinery).
    const written = await writeFileDoc('next-task', '# Next task\n\nclaim the top ready task');
    expect(written?.exists).toBe(true);
    const onDisk = await readFile(join(claude, 'commands', 'next-task.md'), 'utf8');
    expect(onDisk).toBe('# Next task\n\nclaim the top ready task');
    const read = await readFileDoc('next-task');
    expect(read?.content).toBe('# Next task\n\nclaim the top ready task');
  });

  test('editing TASKS.md through the editor is reflected by getOverview', async () => {
    await writeFileDoc('tasks', '# TASKS\n\n---\n## [ ] rubato — brand new task\nbody\n');
    const ov = await getOverview();
    expect(ov.board.counts.ready).toBe(1);
    expect(ov.board.groups.ready[0].title).toBe('rubato — brand new task');
  });

  test('unknown key has no traversal surface (returns null)', async () => {
    expect(await readFileDoc('../../etc/passwd')).toBeNull();
    expect(await writeFileDoc('nope', 'x')).toBeNull();
    expect(await readFileDoc('')).toBeNull();
  });

  test('rejects content over the size cap', async () => {
    await expect(writeFileDoc('loop', 'x'.repeat(2_000_001))).rejects.toThrow(/too large/);
  });

  test('rejects a non-string body', async () => {
    // @ts-expect-error deliberately wrong type
    await expect(writeFileDoc('loop', 123)).rejects.toThrow(/string/);
  });

  test('a symlinked notes dir resolves to its real path (canonicalized), still writable', async () => {
    // Point the notes dir at a SYMLINK to the real temp dir; the allowlist must
    // canonicalize it (realpath) rather than treat the symlinked path as escape.
    const realInner = await mkdtemp(join(tmpdir(), 'rubato-orch-real-'));
    // tmpdir() itself may be a symlink (macOS /var → /private/var), so canonicalize
    // the expected real dir before comparing.
    const canonicalReal = await realpath(realInner);
    const linkPath = join(dir, 'linked-notes');
    await symlink(realInner, linkPath);
    process.env.RUBATO_NOTES_DIR = linkPath;

    const written = await writeFileDoc('tasks', '# TASKS\n\n---\n## [ ] symlink — written via link\n');
    expect(written?.exists).toBe(true);
    // The canonical path is under the REAL dir, not the symlink.
    expect(written?.path.startsWith(canonicalReal)).toBe(true);
    expect(await readFile(join(realInner, 'TASKS.md'), 'utf8')).toContain('written via link');
    await rm(realInner, { recursive: true, force: true });
  });
});

describe('task builder mutations (race-safe TASKS.md edits)', () => {
  const seed = async () =>
    writeFile(join(dir, 'TASKS.md'), '<!-- legend -->\n\n## [ ] alpha\n\n## [ ] (id:keep) beta\nbody.\n');

  test('create inserts at top by default and writes the file atomically', async () => {
    await seed();
    const board = await createTask({ status: 'ready', title: 'gamma' }, { at: 'top' });
    expect(board.groups.ready[0].title).toBe('gamma');
    const onDisk = await readFile(join(dir, 'TASKS.md'), 'utf8');
    expect(onDisk).toContain('## [ ] gamma');
    expect(onDisk).toContain('<!-- legend -->');
    // The lock file is always cleaned up.
    expect(
      await readFile(join(dir, 'TASKS.md.lock'), 'utf8')
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test('create with markers serializes the full heading', async () => {
    await seed();
    const board = await createTask(
      { status: 'hold', title: 'delta', model: 'sonnet', thinkingLevel: 'low', id: 'd', needs: ['keep'] },
      { at: 'bottom' },
    );
    const t = board.tasks.find((x) => x.title === 'delta');
    expect(t?.rawHeading).toBe('## [b] (id:d) (needs:keep) (model:sonnet) (think:low) delta');
  });

  test('before/after position relative to an anchor', async () => {
    await seed();
    const board = await createTask(
      { status: 'ready', title: 'between' },
      { at: 'after', anchorHeading: '## [ ] alpha' },
    );
    const titles = board.tasks.map((t) => t.title);
    expect(titles.indexOf('between')).toBe(titles.indexOf('alpha') + 1);
  });

  test('rejects a duplicate id', async () => {
    await seed();
    await expect(createTask({ status: 'ready', title: 'dup', id: 'keep' }, { at: 'top' })).rejects.toThrow(
      /already used/,
    );
  });

  test('update replaces a task in place (matched by heading)', async () => {
    await seed();
    const board = await updateTask('## [ ] alpha', { status: 'hold', title: 'alpha (held)' });
    expect(board.tasks.find((t) => t.title === 'alpha (held)')?.status).toBe('blocked');
    expect(board.tasks.find((t) => t.title === 'alpha')).toBeUndefined();
  });

  test('update on a vanished anchor throws a conflict (no clobber)', async () => {
    await seed();
    await expect(updateTask('## [ ] ghost', { status: 'ready', title: 'x' })).rejects.toThrow(/no longer in TASKS\.md/);
  });

  test('delete removes the task', async () => {
    await seed();
    const board = await deleteTask('## [ ] (id:keep) beta');
    expect(board.tasks.find((t) => t.title === 'beta')).toBeUndefined();
    expect(board.tasks.find((t) => t.title === 'alpha')).toBeDefined();
  });

  test('concurrent creates all land (no lost updates under the lock)', async () => {
    await seed();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => createTask({ status: 'ready', title: `c${i}` }, { at: 'top' })),
    );
    const onDisk = await readFile(join(dir, 'TASKS.md'), 'utf8');
    for (let i = 0; i < 8; i++) expect(onDisk).toContain(`## [ ] c${i}`);
    // Original tasks survive the barrage.
    expect(onDisk).toContain('## [ ] alpha');
    expect(onDisk).toContain('(id:keep) beta');
  });
});
