#!/usr/bin/env bun
/**
 * ai-ask  (installed as `rubato-ask`)
 *
 * Ask a question about an app from the terminal; the answer streams to stdout.
 * Indexes the app on first use. Needs an LLM endpoint configured (RUBATO_LLM_URL
 * or ai.direct.baseUrl). Sources are printed to stderr so stdout stays the answer.
 *
 * Usage:
 *   rubato-ask <app> <question…>
 */

import { llmFromConfig } from '../api/llm/fromConfig';
import { buildPrompt } from '../lib/ai/prompt';
import { resolveApp } from '../lib/apps';
import { loadConfig } from '../lib/config';
import { getAppMap, getStatus } from '../server/aiDb';
import { indexApp } from '../server/aiIndex';
import { retrieve } from '../server/aiRetrieve';

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const [query, ...rest] = positional;
  const question = rest.join(' ').trim();
  if (!query || !question) {
    console.error('usage: rubato-ask <app> <question…>');
    process.exit(1);
  }

  const app = await resolveApp(query);
  if (!getStatus(app.name)) {
    process.stderr.write(`indexing ${app.name}…\n`);
    await indexApp(app);
  }

  const cfg = await loadConfig();
  const chunks = await retrieve(app, question);
  const maxContextTokens = app.ai?.maxContextTokens ?? cfg.ai?.maxContextTokens ?? 6000;
  const appMap = getAppMap(app.name) ?? undefined;
  const { messages, used } = buildPrompt(app.name, question, chunks, { maxContextTokens, appMap });

  const provider = await llmFromConfig(app);
  const model = app.ai?.model ?? cfg.ai?.direct?.model;

  for await (const chunk of provider.streamChat(messages, { model })) {
    if (chunk.kind === 'text') process.stdout.write(chunk.text);
    else if (chunk.kind === 'error') {
      process.stderr.write(`\n✗ ${chunk.message}\n`);
      process.exit(1);
    }
  }
  process.stdout.write('\n');
  if (used.length) {
    process.stderr.write(`\nsources: ${used.map((u) => `${u.relativePath}:${u.startLine}-${u.endLine}`).join(', ')}\n`);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
