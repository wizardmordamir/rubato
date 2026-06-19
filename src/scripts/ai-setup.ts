#!/usr/bin/env bun
/**
 * ai-setup  (installed as `rubato-ai-setup`)
 *
 * Stage a local model so semantic/hybrid retrieval (embeddings) and cross-encoder
 * re-ranking can run offline. Run it on a machine that can reach the model host
 * (honors HF_ENDPOINT for a mirror); on a locked-down machine, copy a
 * hand-downloaded folder in with `--from`. Files land under
 * ~/.rubato/models/<model>/ (honors RUBATO_HOME), and the index activates the
 * feature automatically on the next reindex.
 *
 * Usage:
 *   rubato-ai-setup                       # download the default embedding model
 *   rubato-ai-setup --model <id>          # a different model id
 *   rubato-ai-setup --rerank              # also stage the default re-ranker
 *   rubato-ai-setup --from <folder>       # copy a hand-staged folder instead
 *   rubato-ai-setup --verify              # check whether it's staged
 */

import { modelStaged } from '../api/embeddings/fromConfig';
import { DEFAULT_EMBED_MODEL } from '../api/embeddings/local';
import { DEFAULT_RERANK_MODEL } from '../api/embeddings/rerank';
import { modelDir, stageModel } from '../lib/ai/stageModel';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const from = getOpt(args, 'from');
  // Models to act on: the embedding model (or --model), plus the re-ranker with --rerank.
  const models = [getOpt(args, 'model') ?? DEFAULT_EMBED_MODEL];
  if (args.includes('--rerank')) models.push(DEFAULT_RERANK_MODEL);

  if (args.includes('--verify')) {
    let allOk = true;
    for (const model of models) {
      const ok = modelStaged(model);
      allOk &&= ok;
      console.log(
        ok ? `✓ ${model} is staged at ${modelDir(model)}` : `✗ ${model} is NOT staged (under ${modelDir(model)})`,
      );
    }
    process.exit(allOk ? 0 : 1);
  }

  for (const model of models) {
    await stageModel(model, { from, force: true, log: (m) => console.log(m) });
    console.log(`✓ ${model} staged.`);
  }
  console.log('\nReindex an app (Ask tab → Reindex) and embeddings/hybrid + re-ranking activate automatically.');
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
