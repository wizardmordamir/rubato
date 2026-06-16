/**
 * Run-history persistence for automation runs — pluggable, like the automation
 * store. The default ({@link createSqliteRunStore}) is the append-only
 * `automation_runs` SQLite table; a friend app can inject its own {@link RunStore}
 * (its own DB/warehouse) via `automationsPlugin({ runStore })` to keep run history
 * off the local SQLite file. The async shape lets a remote backend implement it.
 *
 * (Run *artifacts* — the per-step HTML/screenshots on disk — are separate; this
 * covers the structured run records only.)
 */

import type { AutomationRunRecord } from '../shared/automation';
import {
  deleteAutomationRun,
  deleteAutomationRuns,
  getAutomationRun,
  listAutomationRuns,
  recordAutomationRun,
} from './db';

export interface RunStore {
  /** Append a finished run; returns it with its assigned id. */
  record(run: Omit<AutomationRunRecord, 'id'>): Promise<AutomationRunRecord>;
  /** One run by id, or null. */
  get(id: number): Promise<AutomationRunRecord | null>;
  /** Recent runs, most recent first (optionally for one automation). */
  list(automation?: string, limit?: number): Promise<AutomationRunRecord[]>;
  /** Delete one run row; true if it existed. */
  delete(id: number): Promise<boolean>;
  /** Delete all runs (or one automation's); returns the removed rows so the caller
   *  can clean up each one's on-disk artifacts. */
  deleteMany(automation?: string): Promise<AutomationRunRecord[]>;
}

/** The default run store — the `automation_runs` SQLite table (rubato's own). */
export function createSqliteRunStore(): RunStore {
  return {
    record: async (run) => recordAutomationRun(run),
    get: async (id) => getAutomationRun(id),
    list: async (automation, limit) => listAutomationRuns(automation, limit),
    delete: async (id) => deleteAutomationRun(id),
    deleteMany: async (automation) => deleteAutomationRuns(automation),
  };
}

/** The process-default run store (SQLite). */
export const runStore: RunStore = createSqliteRunStore();
