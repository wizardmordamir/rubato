#!/usr/bin/env bun
/**
 * serve  (installed as `rubato-serve`)
 *
 * Start the local rubato explorer: a small web UI + read API over your app
 * registry, commands, and config. Built on Bun's server — no extra deps.
 *
 * The boot logic lives in src/server/start.ts (shared with the embeddable
 * `on()` entry point); this script is just the CLI wrapper that parses args,
 * prints a banner, and optionally opens a browser.
 *
 * Usage (after rubato-setup):
 *   rubato-serve [--port <n>] [--open]
 */

import { startServer } from '../server/start';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const portArg = getOpt(args, 'port');
const open = args.includes('--open');

const { server, url } = startServer(portArg ? { port: Number(portArg) } : {});
console.log(`rubato explorer → ${url}  (Ctrl-C to stop)`);

if (open) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  Bun.spawn([opener, url]);
}

// Keep a reference so the server isn't considered unused.
void server;
