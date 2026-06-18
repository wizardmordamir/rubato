/**
 * Post-generation sanity checks for code the model emits in a chat answer. These
 * are deliberately CHEAP and HIGH-PRECISION — they catch the exact failure modes a
 * local coder model (qwen3-coder) was observed producing, without the false-positive
 * noise that isolated `tsc` on a fragment would create:
 *
 *   - syntax errors            → in-process `Bun.Transpiler` (no imports/tsconfig needed)
 *   - awaiting callback APIs    → regex (the `await exec(cb)` bug)
 *   - relative paths in FS I/O  → regex (only real fs reads/writes, NOT module imports)
 *
 * An optional, opt-in `tsc --noEmit` pass exists for complete-file snippets but is
 * off by default (it's noisy on fragments). Findings feed the one-shot self-repair
 * turn in ask.ts; they are never shown raw to the user.
 *
 * Server-only (uses the `Bun` global + lazy node:fs). Do not import from the UI.
 */

export interface CodeBlock {
  /** Declared fence language (normalized lowercase). */
  lang: string;
  code: string;
  /** 1-based position among extracted blocks (used in issue messages). */
  index: number;
}

export interface CodeIssue {
  /** 1-based block index this issue belongs to. */
  block: number;
  /** 1-based line within the block, when known. */
  line?: number;
  /** Stable rule id (for tests / telemetry). */
  rule: string;
  message: string;
}

const CODE_LANGS = new Set(['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'mts', 'cts']);

/** Extract fenced code blocks (``` ```ts ``` etc.) from a markdown answer. */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  // ```lang\n …code… \n```  — non-greedy body, tolerant of trailing spaces on the fence.
  const re = /```([a-zA-Z]*)[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let index = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(markdown)) !== null) {
    const lang = (m[1] ?? '').toLowerCase();
    if (!CODE_LANGS.has(lang)) continue; // skip non-code fences (json, bash, text, …)
    index += 1;
    blocks.push({ lang, code: m[2] ?? '', index });
  }
  return blocks;
}

/** 1-based line number for a character offset within `code`. */
function lineAt(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === '\n') line++;
  }
  return line;
}

/** Map a fence language to a Bun.Transpiler loader. */
function loaderFor(lang: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (lang === 'tsx') return 'tsx';
  if (lang === 'jsx') return 'jsx';
  if (lang === 'js' || lang === 'javascript' || lang === 'mts' || lang === 'cts') return 'js';
  return 'ts';
}

/**
 * Syntax-only validation via Bun's transpiler: in-process (~1-5ms), needs no
 * imports/ambient types/tsconfig, and throws on genuine syntax errors (mismatched
 * braces, malformed type annotations, etc.). Reliable; no semantic claims.
 */
export function syntaxCheckBlocks(blocks: CodeBlock[]): CodeIssue[] {
  const issues: CodeIssue[] = [];
  for (const b of blocks) {
    try {
      new Bun.Transpiler({ loader: loaderFor(b.lang) }).transformSync(b.code);
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      issues.push({ block: b.index, rule: 'syntax', message: `SyntaxError: ${message}` });
    }
  }
  return issues;
}

/**
 * Flag awaiting a callback-style API — the classic `await exec('cmd', (e,o)=>…)`
 * bug, where `exec` returns a ChildProcess (not a promise) so the await is a no-op
 * and the callback runs after the function returns.
 *
 * Note: top-level `await` is NOT flagged — it's valid in Bun/ESM, and flagging it
 * would be pure false-positive noise on otherwise-clean script snippets.
 */
export function asyncShapeCheck(blocks: CodeBlock[]): CodeIssue[] {
  const issues: CodeIssue[] = [];
  // `await exec(` where the block never promisifies it / never uses the promises API.
  const awaitExec = /await\s+(?:child_process\.|cp\.)?exec\s*\(/g;
  // `await someFn(… , (args) => …)` — awaiting a call that also passes a callback.
  const awaitWithCb = /await\s+[\w.]+\s*\([^;()]*,\s*(?:async\s*)?\([^)]*\)\s*=>/g;
  for (const b of blocks) {
    const promisified = /promisify|node:child_process\/promises|child_process\/promises|fs\/promises|Bun\.\$|Bun\.spawn/.test(
      b.code,
    );
    if (!promisified) {
      let m: RegExpExecArray | null;
      awaitExec.lastIndex = 0;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((m = awaitExec.exec(b.code)) !== null) {
        issues.push({
          block: b.index,
          line: lineAt(b.code, m.index),
          rule: 'await-callback-exec',
          message:
            "Awaiting `exec` — child_process.exec is callback-style and returns a ChildProcess, not a Promise. Use `const { stdout } = await promisify(exec)(cmd)`, `Bun.$`, or `Bun.spawn`.",
        });
      }
    }
    let m: RegExpExecArray | null;
    awaitWithCb.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = awaitWithCb.exec(b.code)) !== null) {
      issues.push({
        block: b.index,
        line: lineAt(b.code, m.index),
        rule: 'await-with-callback',
        message:
          'Awaiting a call that also takes a callback — mixing async/await with a callback API. Wrap it in a Promise (or use the promise-returning variant) instead.',
      });
    }
  }
  return issues;
}

/**
 * Flag relative paths used in actual filesystem I/O — these should be anchored to
 * `import.meta.dir` / `__dirname` so they don't break when cwd differs. Crucially
 * this does NOT flag relative module specifiers (`import x from './u'`,
 * `require('./u')`), which are normal and correct.
 */
export function lintCodePaths(blocks: CodeBlock[]): CodeIssue[] {
  const issues: CodeIssue[] = [];
  const FS_OPS =
    'readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|createReadStream|createWriteStream|openSync|open|statSync|stat|existsSync|readdir|readdirSync|unlink|unlinkSync|copyFile|copyFileSync|mkdir|mkdirSync|rm|rmSync';
  // <fsop>( './…'  — a relative literal as the first argument to a real fs call.
  const fsRelative = new RegExp(`\\b(?:${FS_OPS})\\s*\\(\\s*['"\`]\\.\\.?/`, 'g');
  // Bun.file('./…') / Bun.write('./…')
  const bunRelative = /\bBun\.(?:file|write)\s*\(\s*['"`]\.\.?\//g;
  for (const b of blocks) {
    for (const re of [fsRelative, bunRelative]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((m = re.exec(b.code)) !== null) {
        issues.push({
          block: b.index,
          line: lineAt(b.code, m.index),
          rule: 'relative-fs-path',
          message:
            'Relative path in a filesystem operation — anchor it with `path.join(import.meta.dir, …)` (or `__dirname`) so it resolves regardless of the process working directory.',
        });
      }
    }
  }
  return issues;
}

/**
 * Optional, opt-in: full `tsc --noEmit` over the extracted blocks. Writes each
 * block to a temp dir under a generated loose tsconfig (skipLibCheck, non-strict,
 * noEmit) and parses diagnostics. Honest caveat: on fragments (missing imports /
 * ambient types) this is noisy — that's why it's off by default and meant for
 * complete-file snippets.
 */
export async function tscCheckBlocks(blocks: CodeBlock[]): Promise<CodeIssue[]> {
  if (!blocks.length) return [];
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tscBin = Bun.which('tsc');
  if (!tscBin) return []; // no tsc on PATH — silently skip rather than error the ask

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubato-tsc-'));
  try {
    const files: string[] = [];
    for (const b of blocks) {
      const ext = b.lang === 'tsx' ? 'tsx' : 'ts';
      const file = path.join(dir, `block${b.index}.${ext}`);
      await fs.writeFile(file, b.code, 'utf8');
      files.push(file);
    }
    await fs.writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          skipLibCheck: true,
          strict: false,
          module: 'esnext',
          target: 'esnext',
          moduleResolution: 'bundler',
          types: [],
          allowJs: true,
          jsx: 'react-jsx',
        },
        files: files.map((f) => path.basename(f)),
      }),
      'utf8',
    );

    const proc = Bun.spawn([tscBin, '--noEmit', '-p', 'tsconfig.json'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(20_000),
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const issues: CodeIssue[] = [];
    // e.g.  block2.ts(5,7): error TS1109: Expression expected.
    const diag = /block(\d+)\.tsx?\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = diag.exec(out)) !== null) {
      issues.push({
        block: Number(m[1]),
        line: Number(m[2]),
        rule: 'tsc',
        message: `tsc: ${m[3]?.trim()}`,
      });
    }
    return issues;
  } catch {
    return []; // tsc unavailable / timed out — never block the ask on the opt-in check
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface CodeCheckResult {
  blocks: CodeBlock[];
  issues: CodeIssue[];
}

/**
 * Run the full check suite over a markdown answer. `tsc` is included only when
 * `withTsc` is set (the opt-in `codeEnhanceTsc` flag). Returns the extracted
 * blocks plus the deduped issue list.
 */
export async function runCodeChecks(markdown: string, opts: { withTsc?: boolean } = {}): Promise<CodeCheckResult> {
  const blocks = extractCodeBlocks(markdown);
  if (!blocks.length) return { blocks, issues: [] };
  const issues = [...syntaxCheckBlocks(blocks), ...asyncShapeCheck(blocks), ...lintCodePaths(blocks)];
  if (opts.withTsc) issues.push(...(await tscCheckBlocks(blocks)));
  return { blocks, issues };
}

/** Render issues into the user-message body for a self-repair turn. */
export function formatIssuesForRepair(issues: CodeIssue[]): string {
  const lines = issues.map((i) => {
    const where = i.line ? `block ${i.block}, line ${i.line}` : `block ${i.block}`;
    return `- [${where}] ${i.message}`;
  });
  return lines.join('\n');
}
