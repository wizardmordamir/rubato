/**
 * Automation store — one user-editable JSON file per automation under
 * ~/.rubato/automations/. Like the app registry (apps.ts), these live outside the
 * repo, are hand-editable, and relocate with RUBATO_HOME. The filename is the
 * automation id (a slug derived from its name).
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Automation } from '../shared/automation';
import { RUBATO_HOME } from './config';

const DIR = resolve(RUBATO_HOME, 'automations');

/** Slugify a name into a stable, filesystem-safe id. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'automation'
  );
}

async function ensureDir(): Promise<void> {
  await mkdir(DIR, { recursive: true });
}

function fileFor(id: string): string {
  return resolve(DIR, `${id}.json`);
}

/** All saved automations, most recently updated first. */
export async function listAutomations(): Promise<Automation[]> {
  await ensureDir();
  const names = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
  const all: Automation[] = [];
  for (const name of names) {
    try {
      all.push(JSON.parse(await readFile(resolve(DIR, name), 'utf8')));
    } catch (err) {
      // Skip a malformed file, but say so — otherwise an edited automation just vanishes.
      console.warn(`[rubato] skipping automation ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getAutomation(id: string): Promise<Automation | null> {
  try {
    return JSON.parse(await readFile(fileFor(id), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Create or update an automation. Assigns id/timestamps when missing. The id is
 * derived from the name on first save and then preserved (renaming keeps the id).
 */
export async function saveAutomation(
  input: Partial<Automation> & { name: string; steps: Automation['steps'] },
): Promise<Automation> {
  await ensureDir();
  const now = Date.now();
  const id = input.id || slugify(input.name);
  const existing = await getAutomation(id);
  // Preserve the capture track when a save omits it (e.g. a steps-only edit of a
  // captured flow), but let a save set/replace it.
  const capture = input.capture ?? existing?.capture;
  const automation: Automation = {
    id,
    name: input.name,
    description: input.description,
    startUrl: input.startUrl,
    steps: input.steps,
    ...(capture ? { capture } : {}),
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
  await writeFile(fileFor(id), `${JSON.stringify(automation, null, 2)}\n`);
  return automation;
}

export async function deleteAutomation(id: string): Promise<boolean> {
  try {
    await unlink(fileFor(id));
    return true;
  } catch {
    return false;
  }
}
