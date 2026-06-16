/**
 * Pipeline store — one user-editable JSON file per pipeline under
 * ~/.rubato/pipelines/, exactly like the automation store (automations.ts). A
 * pipeline is an ordered list of heterogeneous stages (automation | script | …)
 * run in sequence, sharing a vars bag + a per-run working dir.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pipeline } from '../shared/pipeline';
import { slugify } from './automations';
import { RUBATO_HOME } from './config';

const DIR = resolve(RUBATO_HOME, 'pipelines');

async function ensureDir(): Promise<void> {
  await mkdir(DIR, { recursive: true });
}

function fileFor(id: string): string {
  return resolve(DIR, `${id}.json`);
}

/** All saved pipelines, most recently updated first. */
export async function listPipelines(): Promise<Pipeline[]> {
  await ensureDir();
  const names = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
  const all: Pipeline[] = [];
  for (const name of names) {
    try {
      all.push(JSON.parse(await readFile(resolve(DIR, name), 'utf8')));
    } catch (err) {
      console.warn(`[rubato] skipping pipeline ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getPipeline(id: string): Promise<Pipeline | null> {
  try {
    return JSON.parse(await readFile(fileFor(id), 'utf8'));
  } catch {
    return null;
  }
}

/** Create or update a pipeline. Assigns id/timestamps when missing (id sticks). */
export async function savePipeline(
  input: Partial<Pipeline> & { name: string; stages: Pipeline['stages'] },
): Promise<Pipeline> {
  await ensureDir();
  const now = Date.now();
  const id = input.id || slugify(input.name);
  const existing = await getPipeline(id);
  const pipeline: Pipeline = {
    id,
    name: input.name,
    description: input.description,
    stages: input.stages,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
  await writeFile(fileFor(id), `${JSON.stringify(pipeline, null, 2)}\n`);
  return pipeline;
}

export async function deletePipeline(id: string): Promise<boolean> {
  try {
    await unlink(fileFor(id));
    return true;
  } catch {
    return false;
  }
}
