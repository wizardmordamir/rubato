#!/usr/bin/env bun
/**
 * gotab  (installed as a shell function)
 *
 * Resolves a query (name / dir / repo / package name / alias) to an app and
 * opens it in your configured editor (config.editor, e.g. code / cursor / open).
 * An unregistered query that is itself a real path (e.g. `gotab ~/notes.md`) is
 * opened directly. When nothing matches, the app registry (apps.json) is opened
 * instead — so you can add the missing entry right then.
 *
 * Usage (after rubato-setup):  gotab myapp
 */

import { tryResolveAppOrPath } from '../lib/apps';
import { APPS_FILE } from '../lib/config';
import { openInEditor } from '../lib/editor';

const query = process.argv[2];
if (!query) {
  console.error('usage: gotab <name|alias|path>');
  process.exit(1);
}

const target = (await tryResolveAppOrPath(query)) ?? { name: 'app registry', absolutePath: APPS_FILE };
if (target.absolutePath === APPS_FILE) {
  console.error(`rubato: no app or path matches "${query}" — opening ${APPS_FILE} so you can add it.`);
}

try {
  const { editor, path } = await openInEditor(target.absolutePath);
  console.log(`Opened ${target.name} in ${editor} (${path})`);
} catch (err) {
  console.error(`Failed to open ${target.name}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
