/**
 * SSH server helpers for the localhost-only Admin → SSH panel.
 *
 * Pure SSH helpers (`buildSshArgs`/`serverLabel`/`buildSshCommand`) live in
 * `src/lib/ssh.ts` and are re-exported here. `openSshInTerminal` is server-
 * specific (spawns a native macOS terminal) and lives only here.
 */

import type { SshServerConfig } from '../lib/config';
import { buildSshArgs, buildSshCommand, serverLabel } from '../lib/ssh';

export { buildSshArgs, buildSshCommand, serverLabel };

/** Result returned from openSshInTerminal. */
export interface SshOpenResult {
  method: 'iterm2' | 'terminal-app' | 'vscode-terminal' | 'editor';
  command: string;
}

/**
 * Open the SSH command in a native terminal (macOS). Tries iTerm2 first, then
 * the built-in Terminal.app. Falls back to the configured editor if neither is
 * available. Throws if nothing can be opened.
 *
 * This is a fire-and-forget operation — it launches a detached process and
 * returns immediately; the terminal appears asynchronously on the desktop.
 */
export async function openSshInTerminal(server: SshServerConfig): Promise<SshOpenResult> {
  const cmd = buildSshCommand(server);

  // iTerm2 — preferred when available.
  if (Bun.which('osascript') && (await isAppInstalled('iTerm'))) {
    const script = [
      'tell application "iTerm"',
      '  activate',
      '  tell current window',
      `    create tab with default profile command "${cmd.replace(/"/g, '\\"')}"`,
      '  end tell',
      'end tell',
    ].join('\n');
    const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    proc.unref();
    return { method: 'iterm2', command: cmd };
  }

  // Terminal.app (macOS built-in) — always available on macOS.
  if (Bun.which('osascript')) {
    const script = [
      'tell application "Terminal"',
      '  activate',
      `  do script "${cmd.replace(/"/g, '\\"')}"`,
      'end tell',
    ].join('\n');
    const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    proc.unref();
    return { method: 'terminal-app', command: cmd };
  }

  throw new Error('Could not find osascript (macOS) to open a terminal. Copy the SSH command and run it manually.');
}

/** Check whether a macOS .app is installed at a well-known path. */
async function isAppInstalled(appName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['test', '-d', `/Applications/${appName}.app`], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
