#!/usr/bin/env bun
/**
 * killports  (installed as a shell function)
 *
 * Kill processes listening on a TCP port or an inclusive range of ports.
 *
 * Usage (after rubato-setup):
 *   killports <port>              # kill listeners on one port
 *   killports <start> <end>       # kill listeners across a range
 *   killports <start> [end] --dry-run   # show what would be killed
 */

import { $ } from 'bun';

const MAX_PORT = 65535;

/** Parse port args into a validated inclusive range, or an error message. */
export function parsePortRange(args: string[]): { start: number; end: number } | { error: string } {
  const nums = args.filter((a) => !a.startsWith('--'));
  if (nums.length === 0) return { error: 'usage: killports <start_port> [end_port] [--dry-run]' };

  const start = Number(nums[0]);
  const end = nums[1] !== undefined ? Number(nums[1]) : start;
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_PORT;

  if (!valid(start) || !valid(end)) return { error: `invalid port(s): ${nums.join(' ')}` };
  if (end < start) return { error: `end port ${end} is before start port ${start}` };
  return { start, end };
}

/** PIDs listening on a TCP port (empty when nothing is bound). */
async function pidsOnPort(port: number): Promise<string[]> {
  const res = await $`lsof -ti:${port}`.nothrow().quiet();
  return res.stdout
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parsePortRange(args);
  if ('error' in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');

  let killed = 0;
  for (let port = parsed.start; port <= parsed.end; port++) {
    const pids = await pidsOnPort(port);
    if (pids.length === 0) continue;
    if (dryRun) {
      console.log(`port ${port}: would kill ${pids.join(', ')}`);
      continue;
    }
    await $`kill -9 ${pids}`.nothrow().quiet();
    console.log(`port ${port}: killed ${pids.join(', ')}`);
    killed += pids.length;
  }

  if (!dryRun) {
    console.log(killed ? `Done — ${killed} process(es) killed.` : 'Nothing was listening on those port(s).');
  }
}

if (import.meta.main) await main();
