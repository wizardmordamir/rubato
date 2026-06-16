/**
 * Integration: the `verifyshas` command's logic via its extracted `run(args, io)`
 * (Tier-4 pattern) — exit codes, report-file writing, and output formats, driven
 * in-process against the fake upstream with no subprocess and no `process.exit`.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ensureOutputDir } from '../../lib/runStore';
import { run as verifyshas } from '../../scripts/verifyshas';
import { useHarness } from '../index';
import { captureIo } from '../io';

const h = useHarness();
const A64 = 'a'.repeat(64);
const B64 = 'b'.repeat(64);

/** Make the fake Quay return a specific manifest digest for any tag lookup. */
function quayDigest(digest: string) {
  h.fake.reset();
  h.fake.handler = (ctx) =>
    ctx.service === 'quay' && ctx.path.endsWith('/tag/')
      ? ctx.json({ tags: [{ name: ctx.query.specificTag, manifest_digest: `sha256:${digest}` }] })
      : undefined;
}

async function writeList(name: string, line: string): Promise<string> {
  const file = resolve(h.seed.home, name);
  await Bun.write(file, `${line}\n`);
  return file;
}

describe('verifyshas run()', () => {
  test('missing list file → exit 1, no crash', async () => {
    const io = captureIo();
    const code = await verifyshas(['/no/such/list.txt'], io);
    expect(code).toBe(1);
    expect(io.err_()).toContain('list file not found');
  });

  test('a matching entry PASSes → exit 0 and writes both report files', async () => {
    quayDigest(A64);
    const list = await writeList('pass.txt', `app 1.2.3 sha256:${A64}`);
    const io = captureIo();
    const code = await verifyshas([list], io);
    expect(code).toBe(0);
    expect(io.out_()).toContain('1/1 passed');

    const outDir = await ensureOutputDir();
    expect(await Bun.file(resolve(outDir, 'verifyshas.report.json')).exists()).toBe(true);
    expect(await Bun.file(resolve(outDir, 'verifyshas.report.csv')).exists()).toBe(true);

    // The JSON report carries a self-describing overview header + tabular rows.
    const json = JSON.parse(await Bun.file(resolve(outDir, 'verifyshas.report.json')).text());
    expect(json.overview).toMatchObject({ command: 'verifyshas', summary: { env: '(default)', passed: 1, failed: 0 } });
    expect(typeof json.overview.correlationId).toBe('string');
    expect(Array.isArray(json.rows)).toBe(true);
    // And a companion diagnostic report landed under diagnostics/.
    const diags = (await import('../../server/diagnostics')).listDiagnostics;
    expect((await diags()).some((d) => d.activity === 'verifyshas')).toBe(true);
  });

  test('a digest mismatch FAILs → exit 2; --json prints the report', async () => {
    quayDigest(A64);
    const list = await writeList('fail.txt', `app 1.2.3 sha256:${B64}`);
    const io = captureIo();
    const code = await verifyshas([list, '--json'], io);
    expect(code).toBe(2);
    const report = JSON.parse(io.out_()) as { summary: { failed: number } };
    expect(report.summary.failed).toBe(1);
  });

  test('--csv emits a CSV table to stdout', async () => {
    quayDigest(A64);
    const list = await writeList('csv.txt', `app 1.2.3 sha256:${A64}`);
    const io = captureIo();
    const code = await verifyshas([list, '--csv'], io);
    expect(code).toBe(0);
    expect(io.out_()).toContain('1.2.3');
    expect(io.out_()).toContain(',');
  });
});
