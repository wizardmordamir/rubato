/**
 * Built-in pipeline scripts that ship with rubato (registered at server start,
 * before any embedder scripts so those can override by id). These are the
 * batteries-included counterparts to user/embedder `registerScript` functions —
 * runnable from the UI and as pipeline `script` stages.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jenkinsFromConfig } from '../api/jenkins/fromConfig';
import { completeText } from '../api/llm/complete';
import { llmFromConfig } from '../api/llm/fromConfig';
import { openshiftFromConfig } from '../api/openshift';
import { findMatches, loadApps, resolveAppNamespace } from '../lib/apps';
import { parseAppScanPdf } from '../lib/appscan';
import { type ExtractSpec, extractValue } from '../lib/extractText';
import { fetchJenkinsArtifacts } from '../lib/jenkinsArtifacts';
import { defaultPlanTitle, generatePlan, type PlanInput } from '../lib/remediationPlan';
import type { RegisteredScript } from '../lib/scriptRegistry';
import { savePlan, upsertVulnerability } from './db';

/**
 * `appscan-pdf` — parse an HCL AppScan / ASoC report PDF in the run dir into
 * vulnerability stats. Writes the structured result as JSON (for a downstream
 * `transform` stage / the dashboard DB) and exposes the headline numbers as vars
 * (critical/high/medium/low/total/scanType/application/isAppScan/outFile). When
 * `app` is given (and `store` isn't false), it also upserts the result into the
 * `app_vulnerabilities` table so the Vulnerabilities view picks it up.
 */
const appScanPdf: RegisteredScript = {
  id: 'appscan-pdf',
  name: 'Parse AppScan report PDF',
  description: 'Extract severity counts + scan type from an HCL AppScan / ASoC report PDF in the run dir.',
  params: [
    { name: 'file', type: 'string', description: 'PDF filename in the run dir (default report.pdf)' },
    { name: 'out', type: 'string', description: 'Output JSON filename in the run dir (default appscan.json)' },
    { name: 'app', type: 'string', description: "App name to store the stats under (default: the report's app)" },
    {
      name: 'store',
      type: 'boolean',
      description: 'Store into the Vulnerabilities table (default true when an app is known)',
      default: true,
    },
  ],
  async run({ dir, params, vars, log }) {
    const file = String(params.file || vars.file || 'report.pdf');
    const out = String(params.out || 'appscan.json');
    const inputPath = resolve(dir, file);
    log(`reading ${file}`);
    const report = await parseAppScanPdf(inputPath);
    if (!report.isAppScan) log(`warning: ${file} doesn't look like an AppScan report (parsing best-effort)`);

    const { text: _text, ...stats } = report;
    const outPath = resolve(dir, out);
    await writeFile(outPath, `${JSON.stringify(stats, null, 2)}\n`);
    log(
      `${report.scanType ?? 'unknown'} scan · ${report.total} findings ` +
        `(C${report.severities.critical}/H${report.severities.high}/M${report.severities.medium}/L${report.severities.low}/I${report.severities.informational})` +
        (report.issueTypes.length ? ` · ${report.issueTypes.length} issue types` : ''),
    );

    // Persist to the Vulnerabilities table when an app name is known.
    const app = String(params.app || vars.app || report.application || '').trim();
    const store = params.store !== false && params.store !== 'false';
    if (app && store) {
      upsertVulnerability({
        app,
        scanType: report.scanType ?? '',
        critical: report.severities.critical,
        high: report.severities.high,
        medium: report.severities.medium,
        low: report.severities.low,
        informational: report.severities.informational,
        issueTypes: report.issueTypes,
        sourceFile: file,
        raw: stats,
      });
      log(`stored vulnerability stats for ${app}${report.scanType ? ` (${report.scanType})` : ''}`);
    }

    return {
      status: 'passed',
      vars: {
        critical: String(report.severities.critical),
        high: String(report.severities.high),
        medium: String(report.severities.medium),
        low: String(report.severities.low),
        informational: String(report.severities.informational),
        total: String(report.total),
        issueTypes: String(report.issueTypes.length),
        scanType: report.scanType ?? '',
        application: report.application ?? '',
        app,
        isAppScan: String(report.isAppScan),
        outFile: out,
      },
      detail: stats,
    };
  },
};

/**
 * `jenkins-fetch` — download a Jenkins build's artifacts (default: PDFs) into the
 * run dir, so a downstream `appscan-pdf` stage can parse them. Env-gated: with no
 * Jenkins creds/config it fails the stage with an actionable message rather than
 * crashing. Sets vars `build`/`pdfCount`/`files`/`file`/`dir` for later stages.
 */
const jenkinsFetch: RegisteredScript = {
  id: 'jenkins-fetch',
  name: 'Fetch Jenkins build artifacts',
  description: "Download a build's artifacts (default: PDFs) into the run dir for a downstream stage.",
  params: [
    { name: 'jobPath', type: 'string', description: 'Jenkins job URL path (e.g. job/folder/job/app)' },
    { name: 'build', type: 'string', description: 'Build number or selector (default "lastSuccessfulBuild")' },
    { name: 'match', type: 'string', description: 'Filename regex to download (default \\.pdf$)' },
    { name: 'out', type: 'string', description: 'Subdir of the run dir to write into (default: the run dir)' },
  ],
  async run({ dir, params, vars, log }) {
    const jobPath = String(params.jobPath || vars.jobPath || '').trim();
    if (!jobPath) {
      return { status: 'failed', detail: { error: 'jobPath is required (the Jenkins job URL path)' } };
    }

    let client: Awaited<ReturnType<typeof jenkinsFromConfig>>;
    try {
      client = await jenkinsFromConfig();
    } catch (err) {
      // No creds / config — scaffolded for later, fail gracefully (don't crash the server).
      return { status: 'failed', detail: { error: err instanceof Error ? err.message : String(err) } };
    }

    const destDir = params.out ? resolve(dir, String(params.out)) : dir;
    await mkdir(destDir, { recursive: true });
    log(`fetching artifacts from ${jobPath}`);

    let result: Awaited<ReturnType<typeof fetchJenkinsArtifacts>>;
    try {
      result = await fetchJenkinsArtifacts(client, {
        jobPath,
        build: params.build ? String(params.build) : undefined,
        match: params.match ? String(params.match) : undefined,
        write: (name, bytes) => writeFile(resolve(destDir, name), bytes),
      });
    } catch (err) {
      return { status: 'failed', detail: { error: err instanceof Error ? err.message : String(err) } };
    }

    log(
      `build #${result.buildNumber}: ${result.written.length} of ${result.matched.length} matched artifact(s) downloaded`,
    );
    return {
      status: 'passed',
      vars: {
        build: String(result.buildNumber),
        pdfCount: String(result.written.length),
        files: result.written.join(','),
        file: result.written[0] ?? '',
        dir: params.out ? String(params.out) : '',
      },
      detail: result,
    };
  },
};

/**
 * `openshift-status` — gather a namespace's runtime state from the OpenShift/k8s
 * API: pod summary (running/failing/notReady counts + restarts), deployments
 * (image + rollout health + deploy time), and (optionally) recent Warning events.
 * Writes the full snapshot as JSON and exposes headline numbers as vars. Env-gated
 * — no creds/config fails the stage gracefully. (Pipelines use-case 6, API path.)
 */
const openshiftStatus: RegisteredScript = {
  id: 'openshift-status',
  name: 'OpenShift namespace status',
  description: 'Pod summary + deployments (+ warning events) for a namespace via the OpenShift/k8s API.',
  params: [
    { name: 'namespace', type: 'string', description: 'OpenShift project / k8s namespace' },
    {
      name: 'app',
      type: 'string',
      description: 'App name — resolves the namespace from its apps.json openshift config when `namespace` is unset',
    },
    {
      name: 'env',
      type: 'string',
      description: "Environment, to pick a per-env namespace from the app's openshift.namespaces",
    },
    { name: 'events', type: 'boolean', description: 'Include recent Warning events (default false)', default: false },
    { name: 'out', type: 'string', description: 'Output JSON filename in the run dir (default openshift.json)' },
  ],
  async run({ dir, params, vars, log }) {
    // Explicit namespace wins; otherwise resolve it from the named app's apps.json
    // openshift config (per-env when an env is given).
    let namespace = String(params.namespace || vars.namespace || '').trim();
    const appName = String(params.app || vars.app || '').trim();
    if (!namespace && appName) {
      const env = String(params.env || vars.env || '').trim() || undefined;
      const apps = await loadApps();
      const app = apps.find((a) => a.name === appName) ?? findMatches(appName, apps)[0];
      if (app) namespace = resolveAppNamespace(app, env) ?? '';
      if (namespace) log(`resolved namespace "${namespace}" for app "${appName}"${env ? ` (${env})` : ''}`);
    }
    if (!namespace) {
      return {
        status: 'failed',
        detail: {
          error: 'namespace is required (pass `namespace`, or an `app` with an openshift namespace in apps.json)',
        },
      };
    }

    let client: Awaited<ReturnType<typeof openshiftFromConfig>>;
    try {
      client = await openshiftFromConfig();
    } catch (err) {
      return { status: 'failed', detail: { error: err instanceof Error ? err.message : String(err) } };
    }

    try {
      const [summary, deployments] = await Promise.all([
        client.getPodSummary(namespace),
        client.getDeployments(namespace),
      ]);
      const wantEvents = params.events === true || params.events === 'true';
      const events = wantEvents ? await client.getEvents(namespace, { type: 'Warning', limit: 50 }) : [];
      const failing = summary.failed + summary.notReady;

      const out = String(params.out || 'openshift.json');
      await writeFile(
        resolve(dir, out),
        `${JSON.stringify({ namespace, pods: summary, deployments, events }, null, 2)}\n`,
      );
      log(
        `${namespace}: ${summary.total} pods (${summary.running} running, ${failing} failing/not-ready, ` +
          `${summary.restarts} restarts) · ${deployments.length} deployment(s)`,
      );

      return {
        status: 'passed',
        vars: {
          namespace,
          pods: String(summary.total),
          running: String(summary.running),
          failing: String(failing),
          notReady: String(summary.notReady),
          restarts: String(summary.restarts),
          deployments: String(deployments.length),
          outFile: out,
        },
        detail: { summary, deployments, events },
      };
    } catch (err) {
      return { status: 'failed', detail: { error: err instanceof Error ? err.message : String(err) } };
    }
  },
};

/**
 * `ai-remediation-plan` — ask the configured LLM for a Markdown remediation plan
 * from vulnerability data + attached reports in the run dir, write it to the run
 * dir, and (by default) store it in the Plans table for view/edit/export. Closes
 * the jenkins→pdf→parse→vuln chain (pipelines use-cases 1 + 3). Env-gated: with no
 * LLM endpoint configured it fails the stage gracefully (no crash). Reads its data
 * from a JSON file (default: the `appscan-pdf` stage's `outFile` var) and any
 * comma-listed text files. Sets vars `planId`/`planFile`/`planTitle`.
 */
const aiRemediationPlan: RegisteredScript = {
  id: 'ai-remediation-plan',
  name: 'AI remediation plan',
  description: 'Generate a Markdown remediation plan from vulnerability data via the configured LLM.',
  params: [
    { name: 'title', type: 'string', description: 'Plan title (default: derived from the app)' },
    { name: 'app', type: 'string', description: 'App the plan is about' },
    {
      name: 'data',
      type: 'string',
      description: 'JSON file in the run dir to summarize (default: the appscan-pdf outFile)',
    },
    { name: 'files', type: 'string', description: 'Comma-list of text files in the run dir to attach' },
    { name: 'instructions', type: 'string', description: 'Extra steering instructions for the model' },
    { name: 'out', type: 'string', description: 'Markdown filename to write (default plan.md)' },
    { name: 'store', type: 'boolean', description: 'Store into the Plans table (default true)', default: true },
  ],
  async run({ dir, params, vars, log }) {
    // Gather structured data: an explicit JSON file, else the appscan-pdf output.
    let data: unknown;
    const dataFile = String(params.data || vars.outFile || '').trim();
    if (dataFile) {
      try {
        data = JSON.parse(await readFile(resolve(dir, dataFile), 'utf8'));
      } catch {
        log(`note: couldn't read/parse ${dataFile} — continuing without it`);
      }
    }

    // Attach any text files the caller listed.
    const files: { name: string; text: string }[] = [];
    for (const f of String(params.files || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        files.push({ name: f, text: await readFile(resolve(dir, f), 'utf8') });
      } catch {
        log(`note: couldn't read attached file ${f}`);
      }
    }

    const app = String(params.app || vars.app || '').trim() || undefined;
    const input: PlanInput = {
      title: params.title ? String(params.title) : undefined,
      app,
      data,
      files: files.length ? files : undefined,
      instructions: params.instructions ? String(params.instructions) : undefined,
    };

    // The LLM provider is env-gated — fail the stage cleanly when unconfigured.
    let md: string;
    try {
      const provider = await llmFromConfig();
      log('asking the model for a remediation plan…');
      md = await generatePlan((messages) => completeText(provider, messages), input);
    } catch (err) {
      return { status: 'failed', detail: { error: err instanceof Error ? err.message : String(err) } };
    }

    const out = String(params.out || 'plan.md');
    await writeFile(resolve(dir, out), md.endsWith('\n') ? md : `${md}\n`);

    const title = defaultPlanTitle(input);
    let planId = '';
    const store = params.store !== false && params.store !== 'false';
    if (store) {
      planId = savePlan({ title, app: app ?? null, source: dir, content: md }).id;
      log(`stored plan "${title}" (${planId})`);
    }
    log(`generated remediation plan (${md.length} chars) → ${out}`);
    return { status: 'passed', vars: { planId, planFile: out, planTitle: title }, detail: { title, chars: md.length } };
  },
};

/**
 * `extract-text` — pull a single value out of unstructured text (a scraped
 * textarea, a downloaded report) into a var for later stages / an automation's
 * `${VAR}` form-fill. Source is a run-dir file (`source`) or a prior var
 * (`fromVar`). Pick the value with one of:
 *   - kind=regex: `pattern` (+ `flags`/`group`)
 *   - kind=afterAnchor: find `anchor`, then the next line by `startsWith` (or
 *     `pattern`) — e.g. anchor=app name, startsWith="sha256:"
 *   - kind=lineContaining: the line with `contains` (+ optional `pattern`/`group`)
 */
const extractText: RegisteredScript = {
  id: 'extract-text',
  name: 'Extract a value from text',
  description: 'Pull a value (regex / find-anchor-then-line / line-containing) from a run-dir file or var into a var.',
  params: [
    { name: 'source', type: 'string', description: 'Filename in the run dir to read (else use fromVar)' },
    { name: 'fromVar', type: 'string', description: 'Read the text from this var instead of a file' },
    { name: 'kind', type: 'string', description: 'regex | afterAnchor | lineContaining (default regex)' },
    { name: 'pattern', type: 'string', description: 'RegExp source (regex / sub-capture for the other kinds)' },
    { name: 'flags', type: 'string', description: 'RegExp flags (e.g. i, m)' },
    { name: 'group', type: 'number', description: 'Capture group to return (default 0 = whole match)' },
    { name: 'anchor', type: 'string', description: 'afterAnchor: the line to find first' },
    { name: 'startsWith', type: 'string', description: 'afterAnchor: return the next line starting with this' },
    { name: 'contains', type: 'string', description: 'lineContaining: the substring identifying the line' },
    { name: 'saveAs', type: 'string', description: 'Var name to store the extracted value (default extracted)' },
    {
      name: 'required',
      type: 'boolean',
      description: 'Fail the stage if nothing matched (default true)',
      default: true,
    },
  ],
  async run({ dir, params, vars, log }) {
    const saveAs = String(params.saveAs || 'extracted');
    // Resolve the source text: a run-dir file, or a prior var.
    let text: string;
    if (params.source) {
      try {
        text = await readFile(resolve(dir, String(params.source)), 'utf8');
      } catch (err) {
        return {
          status: 'failed',
          detail: { error: `could not read ${params.source}: ${err instanceof Error ? err.message : String(err)}` },
        };
      }
    } else if (params.fromVar) {
      text = vars[String(params.fromVar)] ?? '';
    } else {
      return { status: 'failed', detail: { error: 'a `source` file or a `fromVar` is required' } };
    }

    const kind = String(params.kind || 'regex');
    const group = params.group != null ? Number(params.group) : undefined;
    let spec: ExtractSpec;
    if (kind === 'afterAnchor') {
      if (!params.anchor) return { status: 'failed', detail: { error: 'afterAnchor needs an `anchor`' } };
      spec = {
        kind: 'afterAnchor',
        anchor: String(params.anchor),
        startsWith: params.startsWith != null ? String(params.startsWith) : undefined,
        pattern: params.pattern != null ? String(params.pattern) : undefined,
        flags: params.flags != null ? String(params.flags) : undefined,
        group,
        skipBlank: true,
      };
    } else if (kind === 'lineContaining') {
      if (!params.contains) return { status: 'failed', detail: { error: 'lineContaining needs `contains`' } };
      spec = {
        kind: 'lineContaining',
        contains: String(params.contains),
        pattern: params.pattern != null ? String(params.pattern) : undefined,
        flags: params.flags != null ? String(params.flags) : undefined,
        group,
      };
    } else {
      if (!params.pattern) return { status: 'failed', detail: { error: 'regex needs a `pattern`' } };
      spec = {
        kind: 'regex',
        pattern: String(params.pattern),
        flags: params.flags != null ? String(params.flags) : undefined,
        group,
      };
    }

    let value: string | null;
    try {
      value = extractValue(text, spec);
    } catch (err) {
      return {
        status: 'failed',
        detail: { error: `bad pattern: ${err instanceof Error ? err.message : String(err)}` },
      };
    }

    const required = params.required !== false && params.required !== 'false';
    if (value == null) {
      if (required) return { status: 'failed', detail: { error: `no match for ${kind} (saveAs ${saveAs})` } };
      log(`no match — ${saveAs} left empty`);
      return { status: 'passed', vars: { [saveAs]: '', matched: 'false' } };
    }
    log(`${saveAs} = ${value}`);
    return { status: 'passed', vars: { [saveAs]: value, matched: 'true' }, detail: { value } };
  },
};

/** Every built-in script, registered at server start. */
export const BUILTIN_SCRIPTS: RegisteredScript[] = [
  appScanPdf,
  jenkinsFetch,
  openshiftStatus,
  aiRemediationPlan,
  extractText,
];
