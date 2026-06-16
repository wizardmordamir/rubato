#!/usr/bin/env bun
/**
 * ai-setup  (installed as `rubato-ai-setup`)
 *
 * Stage the local embedding model so semantic/hybrid retrieval can run offline.
 * Run it on a machine that can reach the model host (honors HF_ENDPOINT for a
 * mirror); on a locked-down machine, copy a hand-downloaded folder in with
 * `--from`. Files land under ~/.rubato/models/<model>/ (honors RUBATO_HOME), and
 * the index activates embeddings automatically on the next reindex.
 *
 * Usage:
 *   rubato-ai-setup                       # download the default model
 *   rubato-ai-setup --model <id>          # a different model id
 *   rubato-ai-setup --from <folder>       # copy a hand-staged folder instead
 *   rubato-ai-setup --verify              # check whether it's staged
 */

import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { modelStaged } from '../api/embeddings/fromConfig';
import { DEFAULT_EMBED_MODEL, MODELS_DIR } from '../api/embeddings/local';

/** The files transformers.js needs for a quantized feature-extraction model. */
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const model = getOpt(args, 'model') ?? DEFAULT_EMBED_MODEL;
  const from = getOpt(args, 'from');
  const dest = resolve(MODELS_DIR, ...model.split('/'));

  if (args.includes('--verify')) {
    const ok = modelStaged(model);
    console.log(ok ? `✓ ${model} is staged at ${dest}` : `✗ ${model} is NOT staged (missing files under ${dest})`);
    process.exit(ok ? 0 : 1);
  }

  await mkdir(dest, { recursive: true });

  if (from) {
    const src = resolve(from);
    console.log(`Copying ${model}\n  from ${src}\n  to   ${dest}`);
    for (const file of FILES) {
      const d = resolve(dest, file);
      await mkdir(dirname(d), { recursive: true });
      await cp(resolve(src, file), d);
    }
  } else {
    const base = (process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '');
    console.log(`Downloading ${model}\n  from ${base}\n  to   ${dest}`);
    for (const file of FILES) {
      const url = `${base}/${model}/resolve/main/${file}`;
      process.stdout.write(`  ${file} … `);
      const res = await fetch(url);
      if (!res.ok) {
        console.error(
          `failed (${res.status}). If your network blocks the host, download on another machine and use --from.`,
        );
        process.exit(1);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const d = resolve(dest, file);
      await mkdir(dirname(d), { recursive: true });
      await Bun.write(d, buf);
      console.log(`${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`);
    }
  }

  // Verify the onnx is real bytes (not a tiny LFS pointer) and all files present.
  const onnx = resolve(dest, 'onnx', 'model_quantized.onnx');
  const big = (await stat(onnx).catch(() => null))?.size ?? 0;
  if (!modelStaged(model) || big < 1_000_000) {
    console.error('\n✗ staging looks incomplete (onnx missing or too small — an LFS pointer?). Re-run, or use --from.');
    process.exit(1);
  }
  console.log(`\n✓ ${model} staged. Reindex an app (Ask tab → Reindex) and embeddings/hybrid activate automatically.`);
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
