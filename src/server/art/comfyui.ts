/**
 * ComfyUI adapter: POST /prompt → poll /history/{id} → GET /view → Buffer.
 *
 * ## Workflow template
 * The adapter loads a workflow-graph JSON in ComfyUI API format (node-id → {class_type, inputs}).
 * The default template is `flux_workflow_api.json` in this directory; users can override it by
 * placing their own API-format JSON at `~/.rubato/comfyui_workflow.json`.
 *
 * ## Dynamic model discovery
 * Available checkpoint/unet filenames are discovered at generation time by calling ComfyUI's
 * `GET /object_info/<NodeType>` endpoint and reading the first input enum. The loader node type
 * in the template is auto-detected (UnetLoaderGGUF, CheckpointLoaderSimple, etc.).
 * No model names are hardcoded in this module.
 *
 * ## Config/env
 * - Base URL: `art.url` in `~/.rubato/config.json`, or `RUBATO_COMFYUI_URL` env var,
 *   or default http://localhost:8188.
 * - Workflow template: `~/.rubato/comfyui_workflow.json` (user override) or the bundled default.
 * - Poll interval/retries: constants below (generous for slow M-series hardware).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RUBATO_HOME } from '../../lib/config';
import {
  type DiffusionDeps,
  DiffusionOfflineError,
  type DiffusionRequest,
  type DiffusionResult,
  DiffusionTimeoutError,
} from './diffusion';

// ── Constants ────────────────────────────────────────────────────────────────

/** How long to wait between /history polls (ms). */
const POLL_INTERVAL_MS = 2_000;
/** Max number of polls before declaring a timeout (default: 90 × 2s = 3 min). */
const MAX_POLLS = 90;

// ── Types ────────────────────────────────────────────────────────────────────

/** A node entry in a ComfyUI API-format workflow. */
interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

/** The workflow graph: node_id → node. */
type WorkflowGraph = Record<string, WorkflowNode>;

/** Response from POST /prompt. */
interface PromptResponse {
  prompt_id: string;
  number: number;
  node_errors?: Record<string, unknown>;
}

/** One image descriptor inside a history output node. */
interface HistoryImage {
  filename: string;
  subfolder: string;
  type: string;
}

/** The shape returned by GET /history/{promptId}. */
interface HistoryResponse {
  [promptId: string]: {
    outputs: Record<string, { images?: HistoryImage[] }>;
    status?: { completed?: boolean; status_str?: string };
  };
}

// ── Workflow loading ─────────────────────────────────────────────────────────

/** Absolute path to the bundled default API-format workflow. */
const DEFAULT_WORKFLOW_PATH = resolve(import.meta.dir, 'flux_workflow_api.json');

/** User override path — wins when present. */
function userWorkflowPath(): string {
  return resolve(RUBATO_HOME, 'comfyui_workflow.json');
}

/** Load, parse, and deep-clone the workflow template (deep-clone so each call gets its own copy). */
async function loadWorkflow(customFetch?: typeof fetch): Promise<WorkflowGraph> {
  // User override wins when present.
  let raw: string | null = null;
  try {
    raw = await readFile(userWorkflowPath(), 'utf8');
  } catch {
    // No override — fall through to the bundled default.
  }
  if (raw == null) {
    raw = await readFile(DEFAULT_WORKFLOW_PATH, 'utf8');
  }
  return JSON.parse(raw) as WorkflowGraph;
}

// ── Loader node detection ────────────────────────────────────────────────────

/**
 * Loader node types this adapter knows how to discover models for and how to set
 * the model filename in. Ordered from most-specific to least: a GGUF UNET loader
 * takes priority over a generic checkpoint loader.
 */
const LOADER_NODE_TYPES = ['UnetLoaderGGUF', 'CheckpointLoaderSimple', 'CheckpointLoader'] as const;

type LoaderNodeType = (typeof LOADER_NODE_TYPES)[number];

/** The input field name that holds the model filename, per loader type. */
const MODEL_INPUT_FIELD: Record<LoaderNodeType, string> = {
  UnetLoaderGGUF: 'unet_name',
  CheckpointLoaderSimple: 'ckpt_name',
  CheckpointLoader: 'ckpt_name',
};

/** Find the node ID + type of the model loader in a workflow graph. */
function findLoaderNode(graph: WorkflowGraph): { id: string; type: LoaderNodeType } | null {
  for (const type of LOADER_NODE_TYPES) {
    for (const [id, node] of Object.entries(graph)) {
      if (node.class_type === type) return { id, type };
    }
  }
  return null;
}

// ── Dynamic model discovery ──────────────────────────────────────────────────

/** The /object_info shape we need — only the first input's enum list. */
interface ObjectInfoResponse {
  [nodeType: string]: {
    input?: {
      required?: Record<string, [unknown[], ...unknown[]]>;
    };
  };
}

/**
 * Discover available model filenames from the ComfyUI server by calling
 * `GET /object_info/<NodeType>` and reading the first input's enum array.
 *
 * Returns an empty array when the server is unreachable or has no models
 * for the requested node type (never throws — model listing is best-effort).
 */
export async function listComfyuiModels(baseUrl: string, deps: DiffusionDeps = {}): Promise<string[]> {
  const doFetch = deps.fetch ?? fetch;
  const graph = await loadWorkflow().catch(() => ({}) as WorkflowGraph);
  const loader = findLoaderNode(graph);
  if (!loader) return [];

  const url = `${baseUrl.replace(/\/+$/, '')}/object_info/${loader.type}`;
  let res: Response;
  try {
    res = await doFetch(url, { signal: deps.signal });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  try {
    const data = (await res.json()) as ObjectInfoResponse;
    const nodeInfo = data[loader.type];
    if (!nodeInfo?.input?.required) return [];
    // The first required input is the model picker; its first element is the enum array.
    const inputs = nodeInfo.input.required;
    const firstKey = Object.keys(inputs)[0];
    const firstInput = firstKey ? inputs[firstKey] : undefined;
    if (!Array.isArray(firstInput) || !Array.isArray(firstInput[0])) return [];
    return (firstInput[0] as unknown[]).filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

// ── Workflow patching ────────────────────────────────────────────────────────

/**
 * Patch a deep-cloned workflow graph with the generation parameters.
 * Finds nodes by their `class_type` (robust across user-swapped templates).
 */
function patchWorkflow(graph: WorkflowGraph, req: DiffusionRequest): void {
  for (const node of Object.values(graph)) {
    switch (node.class_type) {
      // Positive prompt.
      case 'CLIPTextEncode':
        if ('text' in node.inputs) node.inputs.text = req.prompt;
        break;

      // Seed — ComfyUI's RandomNoise node.
      case 'RandomNoise': {
        const seed = req.seed != null && req.seed >= 0 ? req.seed : Math.floor(Math.random() * 2_147_483_647);
        node.inputs.noise_seed = seed;
        // Set control_after_generate to "fixed" so the seed sticks.
        if ('control_after_generate' in node.inputs) {
          node.inputs.control_after_generate = 'fixed';
        }
        break;
      }

      // Width/height on the latent image node.
      case 'EmptySD3LatentImage':
      case 'EmptyLatentImage':
        node.inputs.width = req.width;
        node.inputs.height = req.height;
        break;

      // ModelSamplingFlux also carries width/height for shift auto-adjustment.
      case 'ModelSamplingFlux':
        if ('width' in node.inputs) node.inputs.width = req.width;
        if ('height' in node.inputs) node.inputs.height = req.height;
        break;

      // Guidance scale.
      case 'FluxGuidance':
        if ('guidance' in node.inputs && req.guidanceScale != null) {
          node.inputs.guidance = req.guidanceScale;
        }
        break;

      // Steps (BasicScheduler carries the step count).
      case 'BasicScheduler':
        if ('steps' in node.inputs && req.steps > 0) {
          node.inputs.steps = req.steps;
        }
        break;

      default:
        break;
    }
  }

  // Base model override (applies to the detected loader node only).
  if (req.baseModel) {
    const loader = findLoaderNode(graph);
    if (loader) {
      const field = MODEL_INPUT_FIELD[loader.type];
      graph[loader.id].inputs[field] = req.baseModel;
    }
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

async function safeFetch(doFetch: typeof fetch, url: string, init: RequestInit, baseUrl: string): Promise<Response> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    if (isAbortError(err)) throw new DiffusionTimeoutError(err);
    throw new DiffusionOfflineError(baseUrl, err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ComfyUI ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res;
}

// ── Main adapter ─────────────────────────────────────────────────────────────

/**
 * ComfyUI adapter: submit a workflow → poll history → download image bytes.
 *
 * @param baseUrl - The ComfyUI server base URL (e.g. http://localhost:8188).
 * @param req - Generation parameters.
 * @param deps - Injectable fetch + abort signal.
 */
export async function comfyui(baseUrl: string, req: DiffusionRequest, deps: DiffusionDeps): Promise<DiffusionResult> {
  const doFetch = deps.fetch ?? fetch;
  const base = trimUrl(baseUrl);

  // 1. Load and patch the workflow template.
  const graph = await loadWorkflow();
  patchWorkflow(graph, req);

  // 2. POST /prompt → prompt_id.
  const promptRes = await safeFetch(
    doFetch,
    `${base}/prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph }),
      signal: deps.signal,
    },
    baseUrl,
  );
  const { prompt_id: promptId } = (await promptRes.json()) as PromptResponse;
  if (!promptId) throw new Error('ComfyUI /prompt returned no prompt_id');

  // 3. Poll GET /history/{promptId} until an image output appears.
  const pollInterval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  let imageFile: HistoryImage | null = null;
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    // Check abort before every poll tick.
    if (deps.signal?.aborted) throw new DiffusionTimeoutError();

    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));

    let histRes: Response;
    try {
      histRes = await doFetch(`${base}/history/${promptId}`, { signal: deps.signal });
    } catch (err) {
      if (isAbortError(err)) throw new DiffusionTimeoutError(err);
      throw new DiffusionOfflineError(baseUrl, err);
    }
    if (!histRes.ok) continue; // transient — keep polling

    const history = (await histRes.json()) as HistoryResponse;
    const task = history[promptId];
    if (!task) continue; // not in history yet

    // Walk all output nodes; grab the first images[0] we find.
    for (const output of Object.values(task.outputs)) {
      const imgs = output.images;
      if (imgs && imgs.length > 0) {
        imageFile = imgs[0];
        break;
      }
    }
    if (imageFile) break;
  }

  if (!imageFile) {
    throw new DiffusionTimeoutError();
  }

  // 4. GET /view?filename=…&subfolder=…&type=output → PNG bytes.
  const viewUrl =
    `${base}/view?` +
    `filename=${encodeURIComponent(imageFile.filename)}` +
    `&subfolder=${encodeURIComponent(imageFile.subfolder)}` +
    `&type=${encodeURIComponent(imageFile.type)}`;

  const imgRes = await safeFetch(doFetch, viewUrl, { signal: deps.signal }, baseUrl);
  const image = Buffer.from(await imgRes.arrayBuffer());

  // ComfyUI does not echo back the seed it used in the history output (the seed
  // was injected into the RandomNoise node during patching — it's not round-tripped).
  // Return the seed we wrote so callers can reproduce the result.
  const usedSeed = req.seed != null && req.seed >= 0 ? req.seed : undefined;

  return { image, seed: usedSeed };
}
