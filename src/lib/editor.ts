/**
 * Open a path in the user's configured editor (`config.editor` — e.g. code /
 * cursor / open). Shared by the `gotab` CLI and the web UI's "open in editor"
 * shortcut so both resolve the editor the same way.
 */

import { loadConfig } from './config';

export interface OpenInEditorResult {
  /** The editor command that was launched (config.editor). */
  editor: string;
  /** The path handed to it. */
  path: string;
}

/**
 * Launch the configured editor on `absolutePath`. Detached + unref'd so a
 * long-lived editor process never ties up the caller (the rubato server, or the
 * gotab CLI which exits right after). Rejects if the editor binary can't be
 * spawned (e.g. a misconfigured `config.editor`).
 */
export async function openInEditor(absolutePath: string): Promise<OpenInEditorResult> {
  const cfg = await loadConfig();
  const proc = Bun.spawn([cfg.editor, absolutePath], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  proc.unref();
  return { editor: cfg.editor, path: absolutePath };
}
