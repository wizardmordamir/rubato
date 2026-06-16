/**
 * Rally (Broadcom/CA Agile Central) WSAPI v2.0 client, built on the reusable HTTP
 * client. Find a story/task by its FormattedID and update a task's state + notes —
 * pipelines use-case 5 ("find a story, find a task, set it in-progress, add a
 * note"). API-key auth via the `ZSESSIONID` header; `fetch` is injectable for tests.
 *
 *   const rally = await rallyFromConfig();
 *   await rally.setTaskInProgress("TA1234", "started via rubato");
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { optionalEnv, requireEnv } from '../env';

/** A Rally artifact (story/task) — only the fields we fetch are typed. */
export interface RallyArtifact {
  _ref?: string;
  ObjectID?: number;
  FormattedID?: string;
  Name?: string;
  State?: string;
  Notes?: string;
  [key: string]: unknown;
}

export interface RallyClientConfig {
  /** WSAPI base, e.g. "https://rally1.rallydev.com/slm/webservice/v2.0". */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const FETCH_FIELDS = 'FormattedID,Name,State,Notes,ObjectID';

export interface RallyClient {
  readonly api: ApiClient;
  readonly config: RallyClientConfig;
  /** A user story (HierarchicalRequirement) by FormattedID (e.g. "US123"), or null. */
  getStory(formattedId: string): Promise<RallyArtifact | null>;
  /** A task by FormattedID (e.g. "TA456"), or null. */
  getTask(formattedId: string): Promise<RallyArtifact | null>;
  /** Update a task (by ObjectID) — e.g. `{ State, Notes }`. Returns the updated object. */
  updateTask(objectId: number, fields: { State?: string; Notes?: string }): Promise<RallyArtifact>;
  /** Find a task by FormattedID and set it In-Progress (+ optional notes). */
  setTaskInProgress(formattedId: string, notes?: string): Promise<RallyArtifact>;
}

// Rally wraps single-type queries in { QueryResult: { Results: [...] } } and
// updates in { OperationResult: { Object, Errors, Warnings } }.
interface QueryResult<T> {
  QueryResult?: { Results?: T[]; Errors?: string[] };
}
interface OperationResult {
  OperationResult?: { Object?: RallyArtifact; Errors?: string[] };
}

export function createRallyClient(config: RallyClientConfig): RallyClient {
  const api = createApiClient({
    name: 'rally',
    baseUrl: config.baseUrl,
    auth: { type: 'header', name: 'ZSESSIONID', value: config.apiKey },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  const queryByFormattedId = async (type: string, formattedId: string): Promise<RallyArtifact | null> => {
    const res = await api.get<QueryResult<RallyArtifact>>(type, {
      query: { query: `(FormattedID = "${formattedId}")`, fetch: FETCH_FIELDS },
    });
    return res.data.QueryResult?.Results?.[0] ?? null;
  };

  const getStory = (formattedId: string) => queryByFormattedId('hierarchicalrequirement', formattedId);
  const getTask = (formattedId: string) => queryByFormattedId('task', formattedId);

  async function updateTask(objectId: number, fields: { State?: string; Notes?: string }): Promise<RallyArtifact> {
    const res = await api.post<OperationResult>(`task/${objectId}`, { Task: fields });
    const errors = res.data.OperationResult?.Errors ?? [];
    if (errors.length) throw new Error(`rally: update failed — ${errors.join('; ')}`);
    return res.data.OperationResult?.Object ?? { ObjectID: objectId, ...fields };
  }

  async function setTaskInProgress(formattedId: string, notes?: string): Promise<RallyArtifact> {
    const task = await getTask(formattedId);
    if (!task?.ObjectID) throw new Error(`rally: task ${formattedId} not found`);
    return updateTask(task.ObjectID, { State: 'In-Progress', ...(notes ? { Notes: notes } : {}) });
  }

  return { api, config, getStory, getTask, updateTask, setTaskInProgress };
}

/**
 * Build a Rally client from rubato config + env. Base URL from `config.rally.baseUrl`
 * or `RALLY_URL`; API key from `RALLY_API_KEY`. Throws (clear, rubato-init-pointing)
 * when unconfigured — callers env-gate by catching.
 */
export async function rallyFromConfig(): Promise<RallyClient> {
  const cfg = (await loadConfig()) as { rally?: { baseUrl?: string } };
  const baseUrl = cfg.rally?.baseUrl ?? optionalEnv('RALLY_URL');
  if (!baseUrl) {
    throw new Error(
      'rally: base URL not set. Add it to ~/.rubato/config.json (rally.baseUrl) or set RALLY_URL in ~/.rubato/.env (run rubato-init).',
    );
  }
  return createRallyClient({ baseUrl, apiKey: requireEnv('RALLY_API_KEY') });
}
