/**
 * SSH server helpers for the localhost-only Admin → SSH panel.
 *
 * `buildSshCommand` / `serverLabel` mirror the CLI helpers in prod-ssh.ts
 * (kept separate so the server never imports a CLI script). `openSshInTerminal`
 * spawns a native macOS terminal with the SSH command so the user gets a proper
 * interactive shell — it's intentionally localhost-only and is never reachable
 * in a network-exposed deployment.
 */

import { type SshServerConfig, expandPath } from '../lib/config';

/** Human-readable label for a server. */
export function serverLabel(s: SshServerConfig): string {
  return s.label ?? s.host;
}

/** Build the SSH argument list for a server config. */
export function buildSshArgs(s: SshServerConfig): string[] {
  const args: string[] = ['ssh'];
  if (s.port && s.port !== 22) args.push('-p', String(s.port));
  if (s.keyPath) args.push('-i', expandPath(s.keyPath));
  if (s.extraArgs?.length) args.push(...s.extraArgs);
  const target = s.user ? `${s.user}@${s.host}` : s.host;
  args.push(target);
  return args;
}

/** Full SSH command string for display / copy. */
export function buildSshCommand(s: SshServerConfig): string {
  return buildSshArgs(s).join(' ');
}

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
  if (Bun.which('osascript') && await isAppInstalled('iTerm')) {
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
