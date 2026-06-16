import { afterEach, describe, expect, test } from 'bun:test';
import { classifyError, toDiagnosticError } from './report';
import { startDiagnostics, withDiagnostics } from './session';

describe('classifyError', () => {
  test('buckets HTTP + network + timeout + shape + missing-dep', () => {
    expect(classifyError({ status: 404 })).toBe('http-4xx');
    expect(classifyError({ status: 503 })).toBe('http-5xx');
    expect(classifyError({ status: 0, statusText: 'Network Error' })).toBe('network');
    expect(classifyError({ name: 'TimeoutError' })).toBe('timeout');
    expect(classifyError(new Error('Unexpected token < in JSON'))).toBe('parse-shape');
    expect(classifyError(new Error('playwright is not installed — run `bun add playwright`'))).toBe(
      'missing-optional-dep',
    );
    expect(classifyError(new Error('something else'))).toBe('unknown');
  });

  test('toDiagnosticError carries HTTP context off an ApiError-like throw', () => {
    const e = toDiagnosticError({ name: 'ApiError', message: 'boom', status: 500, url: 'http://x/y', method: 'GET' });
    expect(e).toMatchObject({ classification: 'http-5xx', status: 500, url: 'http://x/y', method: 'GET' });
  });
});

describe('diagnostics session', () => {
  afterEach(() => {
    delete process.env.DIAG_TEST_TOKEN;
  });

  test('finish() writes a JSONL log + a JSON report under outputDir/diagnostics', async () => {
    const d = startDiagnostics({ activity: 'unit-test', intent: 'exercise the session', console: false });
    d.step('loading', { count: 3 });
    d.warn('heads up');
    const res = await d.finish();

    expect(res.status).toBe('warn');
    expect(res.logPath).toBeDefined();
    expect(res.reportPath).toBeDefined();

    const report = JSON.parse(await Bun.file(res.reportPath as string).text());
    expect(report.schema).toBe('rubato.diagnostic/1');
    expect(report.activity).toBe('unit-test');
    expect(report.status).toBe('warn');
    expect(report.counts).toMatchObject({ steps: 1, warnings: 1 });

    const log = (await Bun.file(res.logPath as string).text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ level: 'step', msg: 'loading', data: { count: 3 } });
  });

  test('redacts secret env values everywhere they appear', async () => {
    process.env.DIAG_TEST_TOKEN = 'super-secret-token-value';
    const d = startDiagnostics({ activity: 'redact', console: false });
    d.info('calling api', {
      headers: { authorization: 'Bearer super-secret-token-value' },
      note: 'super-secret-token-value',
    });
    const res = await d.finish();

    const logText = await Bun.file(res.logPath as string).text();
    const reportText = await Bun.file(res.reportPath as string).text();
    expect(logText).not.toContain('super-secret-token-value');
    expect(logText).toContain('HIDDEN');
    // The report's env snapshot lists the secret key by presence only, never its value.
    expect(reportText).not.toContain('super-secret-token-value');
    expect(JSON.parse(reportText).env.DIAG_TEST_TOKEN).toBe('(set)');
  });

  test('records a shape mismatch via expected()', async () => {
    const d = startDiagnostics({ activity: 'shape', console: false });
    d.expected({ items: 'wrong' }, { items: [{ id: 1 }] }, 'list endpoint');
    const res = await d.finish();
    const report = JSON.parse(await Bun.file(res.reportPath as string).text());
    expect(report.counts.shapeMismatches).toBe(1);
    expect(report.shapeMismatches[0].diffs[0]).toMatchObject({ path: 'items', kind: 'type-mismatch' });
    expect(report.status).toBe('warn');
  });

  test('withDiagnostics records + re-throws on failure', async () => {
    const failing = withDiagnostics({ activity: 'wrap', console: false }, async (d) => {
      d.step('about to fail');
      throw new Error('kaboom');
    });
    await expect(failing).rejects.toThrow('kaboom');
  });
});
