/**
 * HTTP routes for the Playwright automation builder, split out of router.ts to
 * keep that file focused. Two groups:
 *   /api/automations…   — CRUD over the JSON store + run + run history.
 *   /api/session/…      — drive the headed build browser (launch, test-selector,
 *                         highlight, picker, recorder, capture, snapshot, status).
 * Runs fire in the background; their lifecycle (started/step/completed) streams
 * over /ws, same as command runs.
 */

import { optionalEnv } from '../api/env';
import { type AutomationStore, automationStore as defaultAutomationStore } from '../lib/automations';
import { collectAutomationVars } from '../lib/automationVars';
import { type CaptureStore, captureStore as defaultCaptureStore } from '../lib/captureStore';
import { captureToAutomation } from '../lib/captureToAutomation';
import { automationToSpec } from '../lib/exportSpec';
import { deleteManyRunArtifacts, deleteRunArtifacts } from '../lib/runArtifacts';
import type { Automation, AutomationVariable, BrowserChoice, Target } from '../shared/automation';
import type { RunSpeed } from '../shared/pacing';
import {
  closeSession,
  detectSessionBrowsers,
  launchSession,
  sessionGoto,
  sessionHighlight,
  sessionSetCapture,
  sessionSetPicker,
  sessionSetRecorder,
  sessionSnapshot,
  sessionStatus,
  sessionTestSelector,
  sessionUrl,
} from './browserSession';
import { closeHeldBrowser, runAutomationHeadless } from './engine';
import { json, jsonError, readJsonBody } from './http';
import { planAutomationRuns } from './multiRun';
import { runStore as defaultRunStore, type RunStore } from './runStore';
import { startStep, stepNext, stepPause, stepPlay, stepRestart, stepStatus, stopStep } from './stepRunner';

/** The variables an automation references, each flagged present-in-env or not. */
function automationVariables(automation: Automation): AutomationVariable[] {
  return collectAutomationVars(automation).map((v) => ({
    name: v.name,
    present: optionalEnv(v.name) !== undefined,
    sources: v.sources,
  }));
}

/** Names that aren't resolvable: not in env and not supplied for this run. */
function missingVariables(automation: Automation, supplied: Record<string, string> | undefined): string[] {
  return automationVariables(automation)
    .filter((v) => !v.present && !supplied?.[v.name]?.length)
    .map((v) => v.name);
}

/**
 * /api/automations, /api/automations/:id, /api/automations/run, /api/automation-runs.
 *
 * `stores` injects the persistence backends — `automations` (the JSON store) and
 * `runs` (run history) — each defaulting to rubato's own, so the monolith (router.ts
 * calls this with two args) is unchanged. A friend app injects its own backends by
 * wrapping this; `automationsPlugin({ storage, runStore })` does exactly that.
 */
export async function handleAutomationApi(
  pathname: string,
  req: Request,
  stores: { automations?: AutomationStore; runs?: RunStore; captures?: CaptureStore } = {},
): Promise<Response> {
  const store = stores.automations ?? defaultAutomationStore;
  const runs = stores.runs ?? defaultRunStore;
  const captures = stores.captures ?? defaultCaptureStore;
  if (pathname === '/api/automation-runs') {
    const automation = new URL(req.url).searchParams.get('automation') ?? undefined;
    return json(await runs.list(automation));
  }

  // Delete ALL run outputs (optionally just one automation's): DB rows + the
  // on-disk artifacts (per-step screenshots/HTML, shots, run dirs). Kept by
  // default — this only runs on demand.
  if (pathname === '/api/automation-runs/cleanup') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const b = await readJsonBody<{ automation?: string }>(req);
    const removed = await runs.deleteMany(b?.automation);
    await deleteManyRunArtifacts(removed);
    return json({ deleted: removed.length });
  }

  // Delete ONE run: /api/automation-runs/:id (DELETE) — its DB row + artifacts.
  if (pathname.startsWith('/api/automation-runs/')) {
    const id = Number(pathname.slice('/api/automation-runs/'.length));
    if (!Number.isInteger(id)) return jsonError('bad run id', 400);
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const run = await runs.get(id);
    if (run) await deleteRunArtifacts(run);
    return json({ deleted: await runs.delete(id) });
  }

  if (pathname === '/api/automations/close-browser') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    await closeHeldBrowser();
    return json({ ok: true });
  }

  // Live step-through executor: /api/automations/step[/<action>].
  if (pathname === '/api/automations/step') return json(stepStatus());
  if (pathname.startsWith('/api/automations/step/')) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const action = pathname.slice('/api/automations/step/'.length);
    switch (action) {
      case 'start': {
        const b = await readJsonBody<{ id?: string; automation?: Automation; speed?: RunSpeed }>(req);
        const automation = b?.automation ?? (b?.id ? await store.get(b.id) : null);
        if (!automation) return jsonError('automation not found', 404);
        return json(await startStep(automation, b?.speed ?? 'slow'));
      }
      case 'next':
        return json(stepNext());
      case 'play':
        return json(stepPlay());
      case 'pause':
        return json(stepPause());
      case 'restart':
        return json(await stepRestart());
      case 'stop':
        return json(await stopStep());
      default:
        return jsonError(`unknown step action: ${action}`, 404);
    }
  }

  if (pathname === '/api/automations/run') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const b = await readJsonBody<{
      id?: string;
      automation?: Automation;
      headless?: boolean;
      keepOpen?: boolean;
      speed?: RunSpeed;
      browser?: BrowserChoice;
      variables?: Record<string, string>;
      // When present + non-empty, fan the automation out across these URLs — one
      // parallel run (its own browser context/window) per URL, each with
      // startUrl=url + a TARGET_URL variable. keepOpen (headed) leaves them open.
      urls?: string[];
      // When present + non-empty, fan out one run per row of variables (a matrix):
      // each row's columns become that run's vars over `variables`; a reserved
      // `url` column overrides startUrl + sets TARGET_URL. "Deploy N apps, each with
      // its own task/version/sha/pipeline-type". `rows` takes precedence over `urls`.
      rows?: Record<string, string>[];
    }>(req);
    if (!b) return jsonError('invalid JSON body', 400);
    const automation = b.automation ?? (b.id ? await store.get(b.id) : null);
    if (!automation) return jsonError('automation not found', 404);
    // Re-validate server-side — never trust the client's form to have gated it.
    const missing = missingVariables(automation, b.variables);
    if (missing.length) return jsonError('missing required variables', 400, { missing });
    // Plan one run per target URL (or a single run when no urls). Fire and forget —
    // progress arrives over /ws.
    const { specs, skipped } = planAutomationRuns(automation, b);
    for (const spec of specs) {
      void runAutomationHeadless(spec.automation, {
        headless: spec.headless,
        keepOpen: spec.keepOpen,
        speed: spec.speed,
        browser: b.browser,
        variables: spec.variables,
        runStore: runs,
      });
    }
    return json(
      { accepted: true, automation: automation.name, targetCount: specs.length, ...(skipped ? { skipped } : {}) },
      202,
    );
  }

  if (pathname === '/api/automations') {
    if (req.method === 'GET') return json(await store.list());
    if (req.method === 'POST') {
      const b = await readJsonBody<Partial<Automation> & { name?: string; steps?: Automation['steps'] }>(req);
      if (!b?.name || !Array.isArray(b.steps)) return jsonError('name and steps required', 400);
      return json(await store.save({ ...b, name: b.name, steps: b.steps }));
    }
    return jsonError('use GET or POST', 405);
  }

  // /api/automations/:id/variables — the preload form's data source. Reports which
  // variables a run needs and whether each is already set in env (never the value).
  if (pathname.endsWith('/variables')) {
    const varId = pathname.slice('/api/automations/'.length, -'/variables'.length);
    const a = varId ? await store.get(varId) : null;
    if (!a) return jsonError('not found', 404);
    return json({ variables: automationVariables(a) });
  }

  // /api/automations/:id/steps-from-capture — (re)derive this automation's Steps
  // from its capture track. The recorder's live "recorded-step" stream is held only
  // in the builder's memory, so a reload/refetch (or saving before it lands) can
  // leave a captured flow with screenshots but an empty Steps list — exactly the
  // "captures but no steps" state. The capture manifest IS the durable record (each
  // action moment already carries an automation-shaped action/target/params), so we
  // lift it with the same captureToAutomation conversion (cleaned) and save.
  if (pathname.endsWith('/steps-from-capture')) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const fromCaptureId = pathname.slice('/api/automations/'.length, -'/steps-from-capture'.length);
    const a = fromCaptureId ? await store.get(fromCaptureId) : null;
    if (!a) return jsonError('not found', 404);
    if (!a.capture?.id) return jsonError('this automation has no capture to generate steps from', 400);
    const manifest = await captures.readManifest(a.capture.id);
    if (!manifest) return jsonError('capture not found', 404);
    const derived = captureToAutomation(manifest);
    // Nothing replayable in the capture (only start/manual/navigation noise) — leave
    // the automation untouched and let the UI say so rather than blanking its steps.
    if (derived.steps.length === 0) return json({ automation: a, generated: 0 });
    const automation = await store.save({ ...a, steps: derived.steps, startUrl: a.startUrl || derived.startUrl });
    return json({ automation, generated: derived.steps.length });
  }

  // /api/automations/:id/export — render the automation as a Playwright spec file.
  if (pathname.endsWith('/export')) {
    const exportId = pathname.slice('/api/automations/'.length, -'/export'.length);
    const a = exportId ? await store.get(exportId) : null;
    if (!a) return jsonError('not found', 404);
    return new Response(automationToSpec(a), {
      headers: {
        'content-type': 'text/typescript; charset=utf-8',
        'content-disposition': `attachment; filename="${a.id}.spec.ts"`,
      },
    });
  }

  // /api/automations/:id
  const id = pathname.slice('/api/automations/'.length);
  if (!id) return jsonError('not found', 404);
  if (req.method === 'GET') {
    const a = await store.get(id);
    return a ? json(a) : jsonError('not found', 404);
  }
  if (req.method === 'DELETE') {
    return json({ deleted: await store.delete(id) });
  }
  return jsonError('use GET or DELETE', 405);
}

/** /api/session/<action> — all POST (except url). */
export async function handleSessionApi(pathname: string, req: Request): Promise<Response> {
  const action = pathname.slice('/api/session/'.length);

  if (action === 'url') return json({ url: await sessionUrl() });
  if (action === 'status') return json(await sessionStatus());
  if (action === 'browsers') return json({ browsers: detectSessionBrowsers() });

  if (req.method !== 'POST') return jsonError('use POST', 405);
  const b =
    (await readJsonBody<{ url?: string; target?: Target; on?: boolean; headless?: boolean; browser?: BrowserChoice }>(
      req,
    )) ?? {};

  switch (action) {
    case 'launch':
      if (!b.url) return jsonError('url required', 400);
      await launchSession(b.url, b.headless ?? false, b.browser);
      return json({ ok: true });
    case 'capture':
      return json(await sessionSetCapture(!!b.on));
    case 'snapshot':
      return json(await sessionSnapshot());
    case 'goto':
      if (!b.url) return jsonError('url required', 400);
      await sessionGoto(b.url);
      return json({ ok: true });
    case 'test-selector':
      if (!b.target) return jsonError('target required', 400);
      return json(await sessionTestSelector(b.target));
    case 'highlight':
      if (!b.target) return jsonError('target required', 400);
      await sessionHighlight(b.target);
      return json({ ok: true });
    case 'picker':
      await sessionSetPicker(!!b.on);
      return json({ ok: true });
    case 'recorder':
      await sessionSetRecorder(!!b.on);
      return json({ ok: true });
    case 'stop':
      await closeSession();
      return json({ ok: true });
    default:
      return jsonError(`unknown session action: ${action}`, 404);
  }
}
