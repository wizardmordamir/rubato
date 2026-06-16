#!/usr/bin/env bun
/**
 * shalist  (installed as a shell function)
 *
 * Generate a deploy list for every configured app (or a group/single app): the
 * `app version` / `commit <hash>` / `sha256:<digest>` blocks that pin exactly what
 * should ship. Version + digest come from the latest Quay tag (the reliable
 * anchor); the commit is the latest Jenkins build's commit (best-effort). Review
 * the output, then check it with `verifyshas`.
 *
 * The list also prints to stdout. With `--out <file>` it's written there; with no
 * `--out` a copy lands in `<outputDir>/shalist.txt` (so the web UI "Files" tab
 * shows it).
 *
 * Usage (after rubato-setup):
 *   shalist [app|group] [--env <env>] [--dates | --image] [--out <file>]
 *
 * Logic lives in `run(args, io)` (returns an exit code, prints via `io`) so it's
 * unit-testable in-process — see scriptIo.ts.
 */

import { resolve } from 'node:path';
import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { buildDeployClients } from '../lib/deploy/clients';
import { collectApps } from '../lib/deploy/collect';
import { imageLineToText, type ShaListItem, shaListToText, shaListWithDatesToText } from '../lib/deploy/format';
import { startDiagnostics } from '../lib/diagnostics';
import { ensureOutputDir } from '../lib/runStore';
import { consoleIo, type ScriptIo } from '../lib/scriptIo';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

/** Short "M-D H:MM" stamp from a build timestamp, matching the dated-list style. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function run(args: string[], io: ScriptIo = consoleIo): Promise<number> {
  const env = getOpt(args, 'env');
  const out = getOpt(args, 'out');
  const dated = args.includes('--dates');
  const image = args.includes('--image');
  const filter = args.find((a) => !a.startsWith('--') && a !== env && a !== out);

  const startedAt = Date.now();
  const diag = startDiagnostics({ activity: 'shalist', intent: 'generate deploy list', console: false });

  const apps = selectApps(await loadApps(), { filter }).filter((a) => a.apis?.length);
  if (apps.length === 0) {
    io.err(`shalist: no apps with api config${filter ? ` matching "${filter}"` : ''}. Edit ~/.rubato/apps.json.`);
    diag.error(`no apps with api config${filter ? ` matching "${filter}"` : ''}`);
    await diag.finish('error');
    return 1;
  }

  const clients = await buildDeployClients(apps);
  const records = await collectApps(apps, clients, { env });
  diag.step('collected app records', { apps: apps.length, records: records.length, env: env ?? '(default)' });

  const items: ShaListItem[] = [];
  const skipped: string[] = [];
  for (const r of records) {
    if (!r.quay?.version || !r.quay.sha256) {
      skipped.push(r.app.name);
      continue;
    }
    items.push({
      app: r.label,
      version: r.quay.version,
      commit: r.jenkins?.commit ?? undefined,
      sha256: r.quay.sha256,
      date: dated && r.jenkins ? shortDate(r.jenkins.build.timestamp) : undefined,
    });
  }

  if (skipped.length) diag.warn('apps skipped — no Quay image', { skipped });
  if (items.length === 0) {
    io.err('shalist: no apps produced a version+digest (need Quay config). Run rubato-init.');
    diag.error('no apps produced a version+digest', { skipped });
    await diag.finish('error');
    return 1;
  }

  const text = image ? imageLineToText(items) : dated ? shaListWithDatesToText(items) : shaListToText(items);

  const n = `${items.length} entr${items.length === 1 ? 'y' : 'ies'}`;
  if (out) {
    await Bun.write(out, `${text}\n`);
    io.out(`Wrote ${n} to ${out}`);
  } else {
    // Print for review, and drop a browsable copy in the output dir (Files tab).
    io.out(text);
    const file = resolve(await ensureOutputDir(), 'shalist.txt');
    await Bun.write(file, `${text}\n`);
    io.err(`\n📄 ${file}`);
  }
  if (skipped.length) io.err(`\n(skipped — no Quay image: ${skipped.join(', ')})`);

  // A sibling structured report (the .txt list isn't machine-readable) — the
  // pinned entries as rows + counts/which apps fell out, so a shared output dir
  // explains itself. Best-effort: the .txt list above is the source of truth.
  await emitDataReport(
    {
      overview: {
        command: 'shalist',
        generatedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        args,
        correlationId: diag.correlationId,
        summary: { env: env ?? '(default)', filter: filter ?? null, apps: apps.length, listed: items.length, skipped },
      },
      rows: items.map((i) => ({
        app: i.app,
        version: i.version,
        commit: i.commit ?? '',
        sha256: i.sha256,
        date: i.date ?? '',
      })),
      columns: ['app', 'version', 'commit', 'sha256', 'date'],
    },
    { err: (l) => io.err(l) },
  );

  await diag.finish(skipped.length ? 'warn' : 'ok');
  return 0;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
