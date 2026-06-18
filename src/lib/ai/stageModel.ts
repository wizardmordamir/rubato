/**
 * Stage a transformers.js model's files under ~/.rubato/models/<id>/ so local
 * embeddings / re-ranking can run offline. One DRY implementation shared by the
 * `rubato-ai-setup` CLI and the connected-mode auto-stage path — download from
 * the Hub (honoring HF_ENDPOINT), or copy a hand-downloaded folder with `from`.
 *
 * The files staged are exactly what a quantized feature-extraction / sequence-
 * classification model needs; `modelStaged` (in fromConfig) checks the subset
 * that must be present for the runtime to load.
 */

import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MODELS_DIR } from '../../api/embeddings/local';

/** Files fetched/copied for a quantized model. */
export const STAGE_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/** Minimum plausible size for the real ONNX weights (guards against an LFS pointer). */
const MIN_ONNX_BYTES = 1_000_000;

export interface StageModelOptions {
  /** Copy from this local folder instead of downloading (locked-down machines). */
  from?: string;
  /** Re-stage even if the files already look present. */
  force?: boolean;
  /** Progress sink (default: silent). The CLI passes `console.log`. */
  log?: (msg: string) => void;
}

/** The on-disk directory a model stages to. */
export function modelDir(model: string): string {
  return resolve(MODELS_DIR, ...model.split('/'));
}

/** True when the files the runtime actually loads are present (subset of STAGE_FILES). */
async function looksStaged(dest: string): Promise<boolean> {
  const required = ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'];
  for (const f of required) {
    if (!(await stat(resolve(dest, f)).catch(() => null))) return false;
  }
  const onnx = (await stat(resolve(dest, 'onnx', 'model_quantized.onnx')).catch(() => null))?.size ?? 0;
  return onnx >= MIN_ONNX_BYTES;
}

/**
 * Ensure `model` is staged under MODELS_DIR; returns its directory. No-op (fast
 * path) when already staged and not forced. Throws with an actionable message on
 * a failed download/copy or an incomplete result.
 */
export async function stageModel(model: string, opts: StageModelOptions = {}): Promise<string> {
  const dest = modelDir(model);
  const log = opts.log ?? (() => {});

  if (!opts.force && (await looksStaged(dest))) return dest;
  await mkdir(dest, { recursive: true });

  if (opts.from) {
    const src = resolve(opts.from);
    log(`Copying ${model}\n  from ${src}\n  to   ${dest}`);
    for (const file of STAGE_FILES) {
      const d = resolve(dest, file);
      await mkdir(dirname(d), { recursive: true });
      await cp(resolve(src, file), d);
    }
  } else {
    const base = (process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '');
    log(`Downloading ${model}\n  from ${base}\n  to   ${dest}`);
    for (const file of STAGE_FILES) {
      const url = `${base}/${model}/resolve/main/${file}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch ${file} for ${model} (${res.status}). ` +
            'If your network blocks the host, download on another machine and stage with `from`.',
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const d = resolve(dest, file);
      await mkdir(dirname(d), { recursive: true });
      await Bun.write(d, buf);
      log(`  ${file} … ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`);
    }
  }

  if (!(await looksStaged(dest))) {
    throw new Error('Staging looks incomplete (onnx missing or too small — an LFS pointer?). Re-run, or use `from`.');
  }
  return dest;
}
