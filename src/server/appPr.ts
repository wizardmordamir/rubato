/**
 * Open a pull/merge request for an app from its current branch, via the GitHub
 * (`gh`) or GitLab (`glab`) CLI — detected from the repo's origin. Local + CLI-
 * based (mirrors startprs.ts): the branch must already be pushed (use the Git-
 * actions "Push" first), and the CLI must be installed + authed. Non-interactive
 * (`--fill`/`--yes`), so it never hangs the server waiting on a prompt.
 */

import type { AppConfig } from '../lib/apps';
import { currentBranch, git, isGitRepo, remoteUrl } from '../lib/git';

export type PrHost = 'github' | 'gitlab';

export interface OpenPrResult {
  ok: boolean;
  host?: PrHost;
  url?: string;
  output?: string;
  error?: string;
}

/** github / gitlab from an origin URL (or null for anything else). Pure. */
export function detectPrHost(origin: string | null | undefined): PrHost | null {
  const s = (origin ?? '').toLowerCase();
  if (s.includes('github')) return 'github';
  if (s.includes('gitlab')) return 'gitlab';
  return null;
}

/** The CLI argv to create a PR/MR. Inputs are assumed validated. Pure. */
export function buildPrArgs(host: PrHost, opts: { title?: string; base?: string; draft?: boolean }): string[] {
  const title = opts.title?.trim();
  const base = opts.base?.trim();
  if (host === 'github') {
    const cmd = ['gh', 'pr', 'create'];
    if (title) cmd.push('--title', title, '--body', '');
    else cmd.push('--fill');
    if (base) cmd.push('--base', base);
    if (opts.draft) cmd.push('--draft');
    return cmd;
  }
  const cmd = ['glab', 'mr', 'create', '--fill', '--yes'];
  if (title) cmd.push('--title', title);
  if (base) cmd.push('--target-branch', base);
  if (opts.draft) cmd.push('--draft');
  return cmd;
}

/** A base/target branch we'll pass to the CLI: non-empty, not flag-like, no whitespace. */
const isValidRef = (b: unknown): b is string =>
  typeof b === 'string' && b.length > 0 && !b.startsWith('-') && !/\s/.test(b);

const URL_RE = /(https?:\/\/\S+)/;

async function runCli(dir: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

export async function openAppPr(
  app: AppConfig,
  opts: { title?: string; base?: string; draft?: boolean } = {},
): Promise<OpenPrResult> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, error: 'not a git repo' };

  const host = detectPrHost((await remoteUrl(dir).catch(() => '')) || app.cloneUrl);
  if (!host) return { ok: false, error: 'origin is not a GitHub or GitLab remote' };

  // A PR needs a remote branch — require the branch be pushed (use "Push" first).
  const hasUpstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0;
  if (!hasUpstream) return { ok: false, host, error: 'push this branch first (no upstream set)' };

  const tool = host === 'github' ? 'gh' : 'glab';
  if (!Bun.which(tool)) return { ok: false, host, error: `the ${tool} CLI isn't installed / on PATH` };

  // currentBranch is informational here; the CLI infers head from the checkout.
  await currentBranch(dir).catch(() => undefined);
  const base = isValidRef(opts.base) ? opts.base : undefined;
  const cmd = buildPrArgs(host, { title: opts.title, base, draft: opts.draft });
  const res = await runCli(dir, cmd);
  const url = res.stdout.match(URL_RE)?.[1] ?? res.stderr.match(URL_RE)?.[1];
  if (res.code !== 0) {
    return {
      ok: false,
      host,
      output: (res.stdout || res.stderr).trim() || undefined,
      error: res.stderr.trim() || `${tool} exited ${res.code}`,
    };
  }
  return { ok: true, host, url, output: res.stdout.trim() || undefined };
}
