#!/usr/bin/env bun
/**
 * dodecode  (installed as a shell function)
 *
 * Reconstruct files/dirs from a `doencode` archive. Reads the self-describing
 * header to know whether it's encrypted; if so, supply the same --seed (or
 * you'll be prompted).
 *
 * Usage (after rubato-setup):
 *   dodecode <encodedFile> [--out <dir>] [--seed <seed>] [--force]
 *
 * Defaults: --out ./decoded. Existing files are skipped unless --force.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { type CodecKey, decodeString, decodeToBytes, deriveKey, parseHeader } from '../lib/codec';

interface Opts {
  out?: string;
  seed?: string;
  force: boolean;
  positional: string[];
}

function parse(argv: string[]): Opts {
  const opts: Opts = { force: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) {
      console.error(`dodecode: unknown option ${a}`);
      process.exit(1);
    } else opts.positional.push(a);
  }
  return opts;
}

async function main(): Promise<void> {
  const { out, seed, force, positional } = parse(process.argv.slice(2));
  const encFile = positional[0];
  if (!encFile) {
    console.error('usage: dodecode <encodedFile> [--out <dir>] [--seed <seed>] [--force]');
    process.exit(1);
  }

  let text: string;
  try {
    text = await readFile(resolve(encFile), 'utf-8');
  } catch {
    console.error(`dodecode: cannot read ${encFile}`);
    process.exit(1);
  }

  const lines = text.split('\n');
  const header = parseHeader(lines[0] ?? '');
  const body = header ? lines.slice(1) : lines;

  const codecOpts: CodecKey = {};
  if (header?.encrypted) {
    const usedSeed = seed ?? prompt('Seed for this encrypted archive: ') ?? '';
    if (!usedSeed) {
      console.error('dodecode: this archive is encrypted — a seed is required.');
      process.exit(1);
    }
    if (!header.salt) {
      console.error('dodecode: encrypted archive is missing its salt header.');
      process.exit(1);
    }
    codecOpts.key = deriveKey(usedSeed, Buffer.from(header.salt, 'base64'));
  }

  const outDir = resolve(out ?? 'decoded');
  let written = 0;
  let failed = 0;

  for (const line of body) {
    if (!line.trim()) continue;
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const encPath = line.slice(0, space);
    const encContent = line.slice(space + 1);

    let relPath: string;
    let data: Buffer;
    try {
      relPath = decodeString(encPath, codecOpts);
      data = decodeToBytes(encContent, codecOpts);
    } catch (err) {
      // With a key, the first failure is almost always a wrong seed — bail early.
      if (codecOpts.key) {
        console.error('dodecode: decode failed — wrong seed, or the archive is corrupt.');
        process.exit(1);
      }
      console.error(`dodecode: skipped an entry — ${err instanceof Error ? err.message : err}`);
      failed++;
      continue;
    }

    const dest = resolve(join(outDir, relPath));
    if (dest !== outDir && !dest.startsWith(outDir + sep)) {
      console.error(`dodecode: skipping entry outside output dir: ${relPath}`);
      failed++;
      continue;
    }
    if (!force && existsSync(dest)) {
      console.error(`  exists (use --force): ${relPath}`);
      failed++;
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, data);
    written++;
  }

  console.log(`✅ Decoded ${written} file(s)${failed ? `, ${failed} skipped/failed` : ''} → ${outDir}`);
}

if (import.meta.main) await main();
