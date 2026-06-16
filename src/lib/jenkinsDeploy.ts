/**
 * Generate a rubato Automation that fills a Jenkins "Build with Parameters" form
 * and submits it — the headless, parameterized core of task 42 (deploy an app by
 * filling its task/version/sha/pipeline params), so you don't hand-record one
 * automation per app.
 *
 * Jenkins renders each build parameter as a hidden `<input name="name" value="X">`
 * paired with the value `<input name="value">` (classic Stapler markup: both live
 * in the same `td.setting-main`). So a parameter's value input is reliably the
 * `input[name="value"]` that follows its name-anchor — `jenkinsParamValueSelector`
 * encodes exactly that. The selector strategy is overridable for Jenkins layouts
 * that differ (newer div-based themes); final resolution is verified against the
 * real Jenkins (this generator + selectors are unit- and mock-validated headlessly).
 *
 * Values support `${VAR}` / `${scraped.x}`, so this composes with the `extract-text`
 * script and the variable-matrix fan-out (deploy dozens of apps, each its own row).
 */

import type { Automation, Step, Target } from '../shared/automation';

export interface JenkinsParam {
  /** The Jenkins parameter name (matches the build form, e.g. "VERSION"). */
  name: string;
  /** The value to fill — a literal or a `${VAR}` reference. */
  value: string;
}

export interface JenkinsDeployOptions {
  /** The job URL, e.g. https://jenkins.example.com/job/Deploys/job/my-app */
  jobUrl: string;
  /** The build parameters to fill, in order. */
  params: JenkinsParam[];
  /** Automation name (default derived from the job URL). */
  name?: string;
  /** Automation id/slug (default derived from the name). */
  id?: string;
  /** The submit button's accessible name (default "Build"). */
  submitLabel?: string;
  /** Override the value-input selector per parameter (default: the sibling anchor below). */
  selectorFor?: (paramName: string) => string;
  /** Timestamp for createdAt/updatedAt (callers pass Date.now(); tests pass a fixed value). */
  now?: number;
}

/** The "Build with Parameters" form page for a Jenkins job URL. */
export function jenkinsBuildFormUrl(jobUrl: string): string {
  return `${jobUrl.trim().replace(/\/+$/, '')}/build?delay=0sec`;
}

/** Escape a value for use inside a CSS `[attr="..."]` selector. */
function cssAttrValue(v: string): string {
  return v.replace(/(["\\])/g, '\\$1');
}

/**
 * Playwright/CSS selector for a Build-with-Parameters value input, anchored on the
 * sibling hidden `input[name="name"]` that carries the parameter name (Jenkins's
 * stable name↔value pairing). General-sibling (`~`) keeps it correct when other
 * markup sits between the two inputs within the same parameter cell.
 */
export function jenkinsParamValueSelector(paramName: string): string {
  const v = cssAttrValue(paramName);
  return `input[name="name"][value="${v}"] ~ input[name="value"]`;
}

const slug = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'jenkins-deploy';

/** Last meaningful path segment of a job URL ("…/job/my-app" → "my-app"). */
function jobName(jobUrl: string): string {
  const parts = jobUrl
    .trim()
    .replace(/\/+$/, '')
    .split('/')
    .filter((p) => p && p !== 'job');
  return parts[parts.length - 1] ?? 'job';
}

/**
 * Build a deploy Automation: navigate to the job's parameter form, fill each
 * parameter by its name-anchored selector, then click the submit button.
 */
export function buildJenkinsDeployAutomation(opts: JenkinsDeployOptions): Automation {
  const now = opts.now ?? 0;
  const selectorFor = opts.selectorFor ?? jenkinsParamValueSelector;
  const name = opts.name ?? `Deploy ${jobName(opts.jobUrl)}`;
  const submitLabel = opts.submitLabel ?? 'Build';

  const fillSteps: Step[] = opts.params.map((p, i) => ({
    id: `fill-${i + 1}`,
    action: 'fill',
    target: { kind: 'css', value: selectorFor(p.name) } satisfies Target,
    params: { value: p.value },
    note: `Set ${p.name}`,
  }));

  const submitStep: Step = {
    id: 'submit',
    action: 'click',
    target: { kind: 'role', value: 'button', name: submitLabel },
    note: 'Submit the build',
  };

  return {
    id: opts.id ?? slug(name),
    name,
    description: `Fill the Jenkins build parameters for ${jobName(opts.jobUrl)} and submit.`,
    startUrl: jenkinsBuildFormUrl(opts.jobUrl),
    steps: [...fillSteps, submitStep],
    createdAt: now,
    updatedAt: now,
  };
}
