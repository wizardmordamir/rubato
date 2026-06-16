#!/usr/bin/env bun
/**
 * doencode  (installed as a shell function)
 *
 * Encode a directory (or single file) into one portable text file — every
 * file's path and contents compressed (Brotli) and base64'd, one per line.
 * `dodecode` reconstructs the tree elsewhere.
 *
 * Privacy: pass --seed to encrypt with AES-256-GCM (key derived from the seed).
 * Without a seed it's compression only — smaller, not secret.
 *
 * Usage (after rubato-setup):
 *   doencode <path> [--out <file>] [--seed <seed>] [--max-mb <n>]
 *
 * Defaults: --out ./rubato-encoded.txt, --max-mb 2 (larger files are skipped).
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { buildHeader, deriveKey, encodeBytes, encodeString, newSalt } from '../lib/codec';
import { type WalkedFile, walkFiles } from '../lib/walkFiles';

interface Opts {
  out?: string;
  seed?: string;
  maxMb: number;
  positional: string[];
}

function parse(argv: string[]): Opts {
  const opts: Opts = { maxMb: 2, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--max-mb') opts.maxMb = Number(argv[++i]);
    else if (a.startsWith('--')) {
      console.error(`doencode: unknown option ${a}`);
      process.exit(1);
    } else opts.positional.push(a);
  }
  return opts;
}

async function main(): Promise<void> {
  const { out, seed, maxMb, positional } = parse(process.argv.slice(2));
  const src = positional[0];
  if (!src) {
    console.error('usage: doencode <path> [--out <file>] [--seed <seed>] [--max-mb <n>]');
    process.exit(1);
  }

  const srcAbs = resolve(src);
  const outFile = resolve(out ?? 'rubato-encoded.txt');

  let info;
  try {
    info = await stat(srcAbs);
  } catch {
    console.error(`doencode: no such path: ${srcAbs}`);
    process.exit(1);
  }

  // Directory paths are prefixed with the top folder name so decode recreates it.
  let files: WalkedFile[];
  if (info.isDirectory()) {
    const base = basename(srcAbs);
    files = (await walkFiles(srcAbs)).map((f) => ({
      fullPath: f.fullPath,
      relativePath: join(base, f.relativePath),
    }));
  } else {
    files = [{ fullPath: srcAbs, relativePath: basename(srcAbs) }];
  }

  const salt = seed ? newSalt() : undefined;
  const key = seed && salt ? deriveKey(seed, salt) : undefined;

  const lines = [buildHeader({ version: 1, encrypted: !!key, salt: salt?.toString('base64') })];
  let encoded = 0;
  let skipped = 0;
  for (const file of files) {
    const st = await stat(file.fullPath);
    if (st.size > maxMb * 1024 * 1024) {
      console.error(`  skip (>${maxMb}MB): ${file.relativePath}`);
      skipped++;
      continue;
    }
    const data = await readFile(file.fullPath);
    lines.push(`${encodeString(file.relativePath, { key })} ${encodeBytes(data, { key })}`);
    encoded++;
  }

  await Bun.write(outFile, `${lines.join('\n')}\n`);
  console.log(`✅ Encoded ${encoded} file(s)${skipped ? `, skipped ${skipped}` : ''} → ${outFile}`);
  console.log(
    key
      ? '   Encrypted with your seed — keep it safe; dodecode needs the same seed.'
      : '   Compression only (not secret). Pass --seed <seed> to encrypt.',
  );
}

if (import.meta.main) await main();
