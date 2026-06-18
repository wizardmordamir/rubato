#!/usr/bin/env bun
/**
 * prod-ssh  (installed as a shell function)
 *
 * Open an SSH connection to a configured prod server. Connection details come
 * from ~/.rubato/config.json → servers.ssh[]. If multiple servers are configured,
 * pick one interactively; if exactly one is configured, connect immediately.
 *
 * Typical config (add to ~/.rubato/config.json):
 *   "servers": {
 *     "ssh": [
 *       { "label": "prod", "host": "myapp.example.com", "user": "ubuntu",
 *         "keyPath": "~/.ssh/id_ed25519" }
 *     ]
 *   }
 *
 * Usage (after rubato-setup):  prod-ssh [label|index]
 */

import { loadConfig, type SshServerConfig } from '../lib/config';
import { buildSshArgs, buildSshCommand, serverLabel } from '../lib/ssh';

/** Resolve which server to connect to from the CLI arg (label, index, or auto). */
function resolveServer(arg: string | undefined, servers: SshServerConfig[]): SshServerConfig | null {
  if (!arg) return servers.length === 1 ? servers[0] : null;
  const idx = Number.parseInt(arg, 10);
  if (!Number.isNaN(idx)) return servers[idx - 1] ?? null;
  return servers.find((s) => serverLabel(s).toLowerCase() === arg.toLowerCase()) ?? null;
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  const servers = cfg.servers?.ssh ?? [];

  if (servers.length === 0) {
    console.error(
      'rubato: no SSH servers configured.\n' +
        'Add a "servers.ssh" entry to ~/.rubato/config.json:\n' +
        '  {\n' +
        '    "servers": {\n' +
        '      "ssh": [\n' +
        '        { "label": "prod", "host": "example.com", "user": "ubuntu",\n' +
        '          "keyPath": "~/.ssh/id_ed25519" }\n' +
        '      ]\n' +
        '    }\n' +
        '  }',
    );
    process.exit(1);
  }

  const arg = process.argv[2];
  let server = resolveServer(arg, servers);

  if (!server && servers.length > 1) {
    // Print a numbered menu and prompt.
    console.log('Available SSH servers:');
    servers.forEach((s, i) => {
      const cmd = buildSshCommand(s);
      console.log(`  ${i + 1}. ${serverLabel(s)}  —  ${cmd}`);
    });
    process.stdout.write('\nSelect server (number or label): ');
    const line = await new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.includes('\n')) resolve(buf.trim());
      });
      process.stdin.resume();
    });
    server = resolveServer(line.trim(), servers);
    if (!server) {
      console.error(`rubato: no server matches "${line.trim()}"`);
      process.exit(1);
    }
  }

  if (!server) {
    console.error(`rubato: no server matches "${arg ?? ''}"`);
    process.exit(1);
  }

  const args = buildSshArgs(server);
  const cmd = args.join(' ');
  console.log(`Connecting to ${serverLabel(server)}: ${cmd}`);

  // Replace the current process with SSH so the user gets a proper TTY.
  const proc = Bun.spawn(args, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  process.exit(code);
}

if (import.meta.main) main();
