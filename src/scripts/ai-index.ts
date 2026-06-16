#!/usr/bin/env bun
/**
 * ai-index  (installed as `rubato-index`)
 *
 * (Re)build the context index for an app so you can ask about it. Incremental by
 * default (skips unchanged files); --force rebuilds from scratch. Embeddings are
 * included automatically when a model is staged (see rubato-ai-setup).
 *
 * Usage:
 *   rubato-index <app> [--force]
 */

import { resolveApp } from '../lib/apps';
import { indexApp } from '../server/aiIndex';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const query = args.find((a) => !a.startsWith('--'));
  if (!query) {
    console.error('usage: rubato-index <app> [--force]');
    process.exit(1);
  }
  const app = await resolveApp(query);
  console.log(`Indexing ${app.name}  (${app.absolutePath})…`);
  const status = await indexApp(app, { force });
  if (status.state === 'error') {
    console.error(`✗ ${status.error}`);
    process.exit(1);
  }
  console.log(
    `✓ ${status.scorer}: ${status.files ?? 0} files, ${status.chunks ?? 0} chunks${status.model ? ` (${status.model})` : ''}`,
  );
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
