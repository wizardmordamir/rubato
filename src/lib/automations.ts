/**
 * Automation store — persistence for saved automations.
 *
 * The default ({@link createFileAutomationStore}) keeps one user-editable JSON file
 * per automation under `~/.rubato/automations/`. Like the app registry (apps.ts),
 * those live outside the repo, are hand-editable, and relocate with `RUBATO_HOME`.
 * The filename is the automation id (a slug derived from its name).
 *
 * Persistence is also **pluggable**: an embedding ("friend") app can supply its own
 * {@link AutomationStore} — a database, an object store, an in-memory map — to
 * `automationsPlugin({ storage })`, so automations don't have to live on local
 * disk. The store is a small 4-method interface; the merge/id/timestamp semantics
 * are shared via {@link buildAutomationRecord}, so a custom store only handles raw
 * persistence and can't drift from rubato's save behavior.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Automation } from '../shared/automation';
import { RUBATO_HOME } from './config';

/** What a save accepts: a full or partial automation that at least has a name + steps. */
export type AutomationInput = Partial<Automation> & { name: string; steps: Automation['steps'] };

/**
 * Pluggable persistence for automations. Implement this to store automations
 * somewhere other than local disk and pass it to `automationsPlugin({ storage })`.
 * The default is {@link createFileAutomationStore}; rubato itself always uses it.
 */
export interface AutomationStore {
  /** All saved automations, most recently updated first. */
  list(): Promise<Automation[]>;
  /** One automation by id, or null if absent. */
  get(id: string): Promise<Automation | null>;
  /** Create or update. Assigns id/timestamps + preserves the capture track via
   *  {@link buildAutomationRecord}; returns the persisted record. */
  save(input: AutomationInput): Promise<Automation>;
  /** Remove by id; resolves true if it existed. */
  delete(id: string): Promise<boolean>;
}

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

/**
 * The pure save merge — derive the record to persist from an input + any existing
 * record. Shared by every {@link AutomationStore} so save semantics (id derived
 * from the name on first save then preserved, createdAt kept, capture track
 * preserved when a save omits it) are identical regardless of backend.
 */
export function buildAutomationRecord(input: AutomationInput, existing: Automation | null, now: number): Automation {
  const id = input.id || slugify(input.name);
  // Preserve the capture track when a save omits it (e.g. a steps-only edit of a
  // captured flow), but let a save set/replace it.
  const capture = input.capture ?? existing?.capture;
  const folder = input.folder ?? existing?.folder;
  return {
    id,
    name: input.name,
    description: input.description,
    ...(folder ? { folder } : {}),
    startUrl: input.startUrl,
    steps: input.steps,
    ...(capture ? { capture } : {}),
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * File-backed automation store: one JSON file per automation under `dir`
 * (default `~/.rubato/automations/`). This is rubato's default backend.
 */
export function createFileAutomationStore(dir: string = resolve(RUBATO_HOME, 'automations')): AutomationStore {
  const fileFor = (id: string) => resolve(dir, `${id}.json`);

  const get: AutomationStore['get'] = async (id) => {
    try {
      return JSON.parse(await readFile(fileFor(id), 'utf8'));
    } catch {
      return null;
    }
  };

  return {
    get,
    async list() {
      await mkdir(dir, { recursive: true });
      const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      const all: Automation[] = [];
      for (const name of names) {
        try {
          all.push(JSON.parse(await readFile(resolve(dir, name), 'utf8')));
        } catch (err) {
          // Skip a malformed file, but say so — otherwise an edited automation just vanishes.
          console.warn(`[rubato] skipping automation ${name}: ${err instanceof Error ? err.message : err}`);
        }
      }
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async save(input) {
      await mkdir(dir, { recursive: true });
      const id = input.id || slugify(input.name);
      const record = buildAutomationRecord(input, await get(id), Date.now());
      await writeFile(fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`);
      return record;
    },
    async delete(id) {
      try {
        await unlink(fileFor(id));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The process-default store (`~/.rubato/automations/`). */
export const automationStore: AutomationStore = createFileAutomationStore();

// Back-compat free functions — rubato's own server + scripts call these and get the
// default file store. A friend app that wants a different backend injects its own
// store through `automationsPlugin({ storage })` instead of calling these.
export const listAutomations = (): Promise<Automation[]> => automationStore.list();
export const getAutomation = (id: string): Promise<Automation | null> => automationStore.get(id);
export const saveAutomation = (input: AutomationInput): Promise<Automation> => automationStore.save(input);
export const deleteAutomation = (id: string): Promise<boolean> => automationStore.delete(id);
