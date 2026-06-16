/**
 * On-disk blob storage for Excel Automations. Each automation gets a directory
 * under ~/.rubato/excel/<automationId>/ holding:
 *   - source.<ext>            the immutable uploaded original (for "download original")
 *   - <revisionId>.xlsx       one workbook per revision in the chain
 *
 * Single-user + local-disk only (cursedalchemy's multi-user sibling uses a
 * MediaStore with disk/S3 backends + a binaries table; rubato keeps it simple).
 */

import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RUBATO_HOME } from '../../lib/config';

const EXCEL_DIR = resolve(RUBATO_HOME, 'excel');

const automationDir = (automationId: string): string => resolve(EXCEL_DIR, automationId);

const ensureDir = (automationId: string): string => {
  const dir = automationDir(automationId);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Write a revision's xlsx bytes; returns the byte length stored. */
export async function writeRevisionBytes(automationId: string, revisionId: string, bytes: Uint8Array): Promise<number> {
  const dir = ensureDir(automationId);
  await Bun.write(resolve(dir, `${revisionId}.xlsx`), bytes);
  return bytes.length;
}

/** Read a revision's xlsx bytes, or null when the file is missing. */
export async function readRevisionBytes(automationId: string, revisionId: string): Promise<Uint8Array | null> {
  const file = Bun.file(resolve(automationDir(automationId), `${revisionId}.xlsx`));
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/** Store the immutable uploaded original (kept verbatim for re-download). */
export async function writeSourceBytes(automationId: string, ext: string, bytes: Uint8Array): Promise<void> {
  const dir = ensureDir(automationId);
  await Bun.write(resolve(dir, `source.${ext}`), bytes);
}

/** Read the immutable original bytes, or null when missing. */
export async function readSourceBytes(automationId: string, ext: string): Promise<Uint8Array | null> {
  const file = Bun.file(resolve(automationDir(automationId), `source.${ext}`));
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/** Remove a single revision's file (best-effort). */
export async function removeRevisionFile(automationId: string, revisionId: string): Promise<void> {
  await rm(resolve(automationDir(automationId), `${revisionId}.xlsx`), { force: true });
}

/** Remove an automation's entire blob directory (best-effort). */
export async function removeAutomationDir(automationId: string): Promise<void> {
  await rm(automationDir(automationId), { recursive: true, force: true });
}
