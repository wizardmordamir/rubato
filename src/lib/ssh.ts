import { expandPath, type SshServerConfig } from './config';

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
