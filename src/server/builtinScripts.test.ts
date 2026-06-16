import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAppsCache } from '../lib/apps';
import { APPS_FILE } from '../lib/config';
import type { ScriptRunContext } from '../lib/scriptRegistry';
import { BUILTIN_SCRIPTS } from './builtinScripts';

function makePdf(text: string): Uint8Array {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length 80 >>\nstream\nBT /F1 14 Tf 72 700 Td (${text}) Tj ET\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const appscan = () => BUILTIN_SCRIPTS.find((s) => s.id === 'appscan-pdf');
const jenkinsFetch = () => BUILTIN_SCRIPTS.find((s) => s.id === 'jenkins-fetch');
const aiPlan = () => BUILTIN_SCRIPTS.find((s) => s.id === 'ai-remediation-plan');
const openshiftStatus = () => BUILTIN_SCRIPTS.find((s) => s.id === 'openshift-status');

describe('BUILTIN_SCRIPTS openshift-status', () => {
  const ctx = (params: ScriptRunContext['params']): ScriptRunContext => ({
    dir: mkdtempSync(join(tmpdir(), 'oc-')),
    outputDir: '',
    vars: {},
    params,
    log: () => {},
  });

  test('is registered with the expected id + params', () => {
    expect(openshiftStatus()?.params?.map((p) => p.name)).toEqual(['namespace', 'app', 'env', 'events', 'out']);
  });

  test('fails (not throws) when namespace is missing', async () => {
    const out = await openshiftStatus()?.run(ctx({}));
    expect(out?.status).toBe('failed');
    expect(JSON.stringify(out?.detail)).toMatch(/namespace/);
  });

  test("fails gracefully when OpenShift isn't configured (no creds)", async () => {
    const out = await openshiftStatus()?.run(ctx({ namespace: 'prod' }));
    expect(out?.status).toBe('failed');
    expect(out?.detail).toBeTruthy();
  });

  test("resolves the namespace from a named app's openshift config", async () => {
    // Seed apps.json directly in the (preload-isolated) RUBATO_HOME.
    await Bun.write(
      APPS_FILE,
      JSON.stringify([
        {
          name: 'billing',
          absolutePath: '/code/billing',
          dirName: 'billing',
          group: null,
          aliases: [],
          managed: true,
          apis: [{ name: 'openshift', namespace: 'billing-prod', namespaces: { dev: 'billing-dev' } }],
        },
      ]),
    );
    clearAppsCache();
    try {
      const logs: string[] = [];
      // No explicit namespace → resolves from the app; dev env picks the per-env one.
      const out = await openshiftStatus()?.run({
        dir: mkdtempSync(join(tmpdir(), 'oc-')),
        outputDir: '',
        vars: {},
        params: { app: 'billing', env: 'dev' },
        log: (m) => logs.push(m),
      });
      // It got PAST namespace resolution (any failure is the env-gated client, NOT
      // "namespace is required") and logged the resolved per-env namespace.
      expect(JSON.stringify(out?.detail)).not.toMatch(/namespace is required/);
      expect(logs.join('\n')).toContain('resolved namespace "billing-dev"');
    } finally {
      rmSync(APPS_FILE, { force: true });
      clearAppsCache();
    }
  });
});

describe('BUILTIN_SCRIPTS jenkins-fetch', () => {
  test('is registered with the expected id + params', () => {
    expect(jenkinsFetch()?.params?.map((p) => p.name)).toEqual(['jobPath', 'build', 'match', 'out']);
  });

  const ctx = (params: ScriptRunContext['params']): ScriptRunContext => ({
    dir: mkdtempSync(join(tmpdir(), 'jf-')),
    outputDir: '',
    vars: {},
    params,
    log: () => {},
  });

  test('fails (not throws) when jobPath is missing', async () => {
    const out = await jenkinsFetch()?.run(ctx({}));
    expect(out?.status).toBe('failed');
    expect(JSON.stringify(out?.detail)).toMatch(/jobPath/);
  });

  test("fails gracefully when Jenkins isn't configured (no creds)", async () => {
    // The isolated test home has no Jenkins config/.env → jenkinsFromConfig throws;
    // the script must surface a failed stage, never crash.
    const out = await jenkinsFetch()?.run(ctx({ jobPath: 'job/app' }));
    expect(out?.status).toBe('failed');
    expect(out?.detail).toBeTruthy();
  });
});

describe('BUILTIN_SCRIPTS ai-remediation-plan', () => {
  test('is registered with the expected id + params', () => {
    expect(aiPlan()?.params?.map((p) => p.name)).toEqual([
      'title',
      'app',
      'data',
      'files',
      'instructions',
      'out',
      'store',
    ]);
  });

  test('fails gracefully when no LLM endpoint is configured', async () => {
    // The isolated test home has no RUBATO_LLM_URL → llmFromConfig throws; the
    // script must surface a failed stage (env-gated scaffolding), never crash.
    const out = await aiPlan()?.run({
      dir: mkdtempSync(join(tmpdir(), 'aiplan-')),
      outputDir: '',
      vars: {},
      params: { app: 'billing' },
      log: () => {},
    });
    expect(out?.status).toBe('failed');
    expect(JSON.stringify(out?.detail)).toMatch(/LLM|endpoint/i);
  });
});

describe('BUILTIN_SCRIPTS appscan-pdf', () => {
  test('is registered with the expected id + params', () => {
    const s = appscan();
    expect(s).toBeTruthy();
    expect(s?.params?.map((p) => p.name)).toEqual(['file', 'out', 'app', 'store']);
  });

  test('parses a PDF in the run dir → writes JSON + returns headline vars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'appscan-'));
    writeFileSync(join(dir, 'report.pdf'), makePdf('HCL AppScan Report DAST Critical 2 High 4 Medium 1 Low 9'));

    const logs: string[] = [];
    const ctx: ScriptRunContext = {
      dir,
      outputDir: dir,
      vars: {},
      params: { file: 'report.pdf', out: 'appscan.json' },
      log: (m) => logs.push(m),
    };
    const outcome = await appscan()?.run(ctx);

    expect(outcome?.status).toBe('passed');
    expect(outcome?.vars).toMatchObject({
      critical: '2',
      high: '4',
      medium: '1',
      low: '9',
      total: '16',
      scanType: 'DAST',
      isAppScan: 'true',
      outFile: 'appscan.json',
    });
    const written = JSON.parse(readFileSync(join(dir, 'appscan.json'), 'utf8'));
    expect(written.severities).toEqual({ critical: 2, high: 4, medium: 1, low: 9, informational: 0 });
    expect(written.text).toBeUndefined(); // raw text not persisted to the stats file
  });

  test('with an `app` param it upserts into the Vulnerabilities table', async () => {
    const { clearVulnerabilities, listVulnerabilities } = await import('./db');
    clearVulnerabilities();
    const dir = mkdtempSync(join(tmpdir(), 'appscan-'));
    writeFileSync(join(dir, 'report.pdf'), makePdf('HCL AppScan Report SAST Critical 7 High 1 Medium 0 Low 2'));

    await appscan()?.run({
      dir,
      outputDir: dir,
      vars: {},
      params: { file: 'report.pdf', app: 'my-svc' },
      log: () => {},
    });

    const row = listVulnerabilities().find((r) => r.app === 'my-svc');
    expect(row).toMatchObject({ app: 'my-svc', scanType: 'SAST', critical: 7, high: 1, low: 2, total: 10 });
    clearVulnerabilities();
  });
});

const extractText = () => BUILTIN_SCRIPTS.find((s) => s.id === 'extract-text');

describe('BUILTIN_SCRIPTS extract-text', () => {
  const ctx = (params: ScriptRunContext['params'], vars: Record<string, string> = {}): ScriptRunContext => ({
    dir: mkdtempSync(join(tmpdir(), 'ext-')),
    outputDir: '',
    vars,
    params,
    log: () => {},
  });

  test('is registered', () => {
    expect(extractText()?.id).toBe('extract-text');
  });

  test('afterAnchor over a run-dir file pulls the sha line into a var', async () => {
    const c = ctx({ source: 'blob.txt', kind: 'afterAnchor', anchor: 'my-app', startsWith: 'sha256:', saveAs: 'sha' });
    writeFileSync(join(c.dir, 'blob.txt'), 'header\nmy-app\nnoise\nsha256:deadbeef\n');
    const out = await extractText()?.run(c);
    expect(out?.status).toBe('passed');
    expect(out?.vars).toMatchObject({ sha: 'sha256:deadbeef', matched: 'true' });
  });

  test('regex over a prior var returns a capture group', async () => {
    const out = await extractText()?.run(
      ctx(
        { fromVar: 'log', kind: 'regex', pattern: 'v(\\d+\\.\\d+)', group: 1, saveAs: 'version' },
        { log: 'build v3.4 ok' },
      ),
    );
    expect(out?.vars).toMatchObject({ version: '3.4' });
  });

  test('fails when nothing matched (required default) but passes empty when required=false', async () => {
    expect((await extractText()?.run(ctx({ fromVar: 'x', pattern: 'zzz' }, { x: 'abc' })))?.status).toBe('failed');
    const soft = await extractText()?.run(
      ctx({ fromVar: 'x', pattern: 'zzz', required: false, saveAs: 'v' }, { x: 'abc' }),
    );
    expect(soft?.status).toBe('passed');
    expect(soft?.vars).toMatchObject({ v: '', matched: 'false' });
  });

  test('fails when neither source nor fromVar is given', async () => {
    expect((await extractText()?.run(ctx({ pattern: 'x' })))?.status).toBe('failed');
  });
});
