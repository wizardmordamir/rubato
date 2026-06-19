/**
 * Admin-only "reset from scratch" setup scripts: the shell scripts that rebuild a
 * machine's full rubato + cursedalchemy (ca) toolchain — ollama + models, miniconda,
 * fooocus, the orchestrator workspace, AWS SES/EC2, Cloudflare, and the rubato/ca
 * clones themselves.
 *
 * Where they live: `~/.rubato/setup-scripts/` (SETUP_SCRIPTS_DIR), derived from
 * RUBATO_HOME and therefore OUTSIDE git. The repo ships sanitized *templates* (all
 * placeholders, no secrets) under `setupScriptTemplates/`; the first listing seeds
 * any that are missing into that dir. Seeding is **non-destructive** — it never
 * overwrites a file that already exists, so the admin's edits are safe. The editable
 * copies (which may hold machine-/account-specific values) are never committed.
 *
 * Access model: every route that reaches this module is under `/api/admin/*`, gated
 * by `ui.admin` (404 when off) — so on a loopback single-user server, only the admin
 * owner can view or edit these, and no other surface exposes them.
 *
 * Safety: a request only ever sends a bare file *name* (never a path). The name is
 * gated to a strict basename pattern (no `/`, no `..`, script-ish extension) and the
 * resolved file's parent is realpath-checked against the setup-scripts dir, so there
 * is no path-traversal surface — this module can only ever touch files directly
 * inside `~/.rubato/setup-scripts/`.
 */

import { mkdir, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SETUP_SCRIPTS_DIR } from '../lib/config';
import type { SetupScriptDoc, SetupScriptInfo } from '../shared/types';

export type { SetupScriptDoc, SetupScriptInfo } from '../shared/types';

/** A sane cap so an accidental huge paste can't be written to disk. */
const MAX_BYTES = 512 * 1024;

/** Allowed file names: a basename with a script-ish extension (no slash / traversal). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(sh|bash|zsh|md|txt)$/;

/** One bundled default template (metadata; content is read from disk by name). */
interface TemplateSpec {
  name: string;
  label: string;
  description: string;
}

/**
 * The default scripts shipped with rubato, in display + run order. The README leads;
 * then the orchestrator and each numbered stage. The content for each lives in a
 * sibling `setupScriptTemplates/<name>` file, read lazily and seeded on first listing.
 */
const TEMPLATES: TemplateSpec[] = [
  { name: 'README.md', label: 'README', description: 'How these scripts work + the secret keys they read' },
  {
    name: '00-reset-all.sh',
    label: 'Reset all (orchestrator)',
    description: 'Run every stage in order, or just the ones you name',
  },
  { name: '10-ollama.sh', label: 'Ollama + models', description: 'Install the Ollama runtime and pull local models' },
  { name: '20-miniconda.sh', label: 'Miniconda', description: 'Install Miniconda and create a Python env' },
  { name: '30-fooocus.sh', label: 'Fooocus', description: 'Clone Fooocus and set up its conda env (needs miniconda)' },
  {
    name: '40-orchestrator.sh',
    label: 'Orchestrator config',
    description: 'Task-queue workspace + rubato orchestration config',
  },
  { name: '50-aws-ses.sh', label: 'AWS SES', description: 'Verify a sending domain identity + DKIM' },
  { name: '60-aws-ec2.sh', label: 'AWS EC2', description: 'Launch an EC2 host (idempotent by Name tag)' },
  { name: '70-cloudflare.sh', label: 'Cloudflare DNS', description: 'Upsert a DNS record via the Cloudflare API' },
  { name: '80-rubato-setup.sh', label: 'rubato setup', description: 'Clone + provision rubato from scratch' },
  {
    name: '81-ca-setup.sh',
    label: 'cursedalchemy (ca) setup',
    description: 'Clone + provision cursedalchemy from scratch',
  },
];

const templateFor = (name: string): TemplateSpec | undefined => TEMPLATES.find((t) => t.name === name);
const templateOrder = (name: string): number => {
  const i = TEMPLATES.findIndex((t) => t.name === name);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

/** Validate + trim a requested file name, or `null` if it isn't an allowed basename. */
function safeName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return SAFE_NAME.test(name) ? name : null;
}

/** Read a bundled template's content from the sibling dir, or `null` if it's absent. */
async function templateContent(name: string): Promise<string | null> {
  try {
    return await Bun.file(resolve(import.meta.dir, 'setupScriptTemplates', name)).text();
  } catch {
    return null;
  }
}

/**
 * Resolve a safe name to its absolute path inside the setup-scripts dir, realpath-
 * checking the parent so a symlinked dir can't redirect a write outside it. The dir
 * is created if missing (a first write needs it). Returns `null` for an unsafe name.
 */
async function resolveScript(name: string): Promise<string | null> {
  const safe = safeName(name);
  if (!safe) return null;
  await mkdir(SETUP_SCRIPTS_DIR, { recursive: true });
  const abs = resolve(SETUP_SCRIPTS_DIR, safe);
  try {
    const realRoot = await realpath(SETUP_SCRIPTS_DIR);
    const realParent = await realpath(dirname(abs));
    if (realParent !== realRoot) return null;
  } catch {
    return null;
  }
  return abs;
}

/**
 * Seed any bundled templates that aren't on disk yet (non-destructive: an existing
 * file is never overwritten, so admin edits survive). Returns the names created.
 */
export async function seedSetupScripts(): Promise<string[]> {
  await mkdir(SETUP_SCRIPTS_DIR, { recursive: true });
  const created: string[] = [];
  for (const t of TEMPLATES) {
    const abs = resolve(SETUP_SCRIPTS_DIR, t.name);
    try {
      await stat(abs);
      continue; // already present — leave it (and any edits) alone
    } catch {
      // missing — write the template
    }
    const content = await templateContent(t.name);
    if (content == null) continue; // template file unavailable (e.g. bundled) — skip
    await writeFile(abs, content, 'utf8');
    // Shell scripts are meant to be run directly.
    if (t.name.endsWith('.sh')) await Bun.$`chmod +x ${abs}`.quiet().catch(() => {});
    created.push(t.name);
  }
  return created;
}

/** Build a SetupScriptInfo for a file that exists on disk. */
async function infoFor(name: string, abs: string): Promise<SetupScriptInfo> {
  const t = templateFor(name);
  const st = await stat(abs);
  return {
    name,
    label: t?.label ?? name,
    path: abs,
    size: st.size,
    modifiedAt: st.mtimeMs,
    isTemplate: !!t,
    description: t?.description,
  };
}

/**
 * List the setup scripts (seeding any missing defaults first), templates in run order
 * then any user-added files alphabetically. No content — just metadata + paths.
 */
export async function listSetupScripts(): Promise<SetupScriptInfo[]> {
  await seedSetupScripts();
  let names: string[];
  try {
    names = await readdir(SETUP_SCRIPTS_DIR);
  } catch {
    return [];
  }
  const out: SetupScriptInfo[] = [];
  for (const name of names) {
    if (!safeName(name)) continue; // ignore anything that isn't a plain script file
    const abs = resolve(SETUP_SCRIPTS_DIR, name);
    try {
      out.push(await infoFor(name, abs));
    } catch {
      // vanished between readdir and stat — skip
    }
  }
  out.sort((a, b) => templateOrder(a.name) - templateOrder(b.name) || a.name.localeCompare(b.name));
  return out;
}

/** Read one setup script's contents, or `null` for an unknown/unsafe/absent name. */
export async function readSetupScript(name: string): Promise<SetupScriptDoc | null> {
  const abs = await resolveScript(name);
  if (!abs) return null;
  const safe = safeName(name) as string;
  try {
    const info = await infoFor(safe, abs);
    return { ...info, exists: true, content: await Bun.file(abs).text() };
  } catch {
    return null; // doesn't exist (and the UI only reads names it listed)
  }
}

/**
 * Write one setup script (creating it if absent — the admin may add their own).
 * Returns the new doc, or `null` for an unsafe name; throws on a non-string /
 * oversized body.
 */
export async function writeSetupScript(name: string, content: string): Promise<SetupScriptDoc | null> {
  const abs = await resolveScript(name);
  if (!abs) return null;
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new Error(`content too large (max ${MAX_BYTES} bytes)`);
  }
  const safe = safeName(name) as string;
  await writeFile(abs, content, 'utf8');
  if (safe.endsWith('.sh')) await Bun.$`chmod +x ${abs}`.quiet().catch(() => {});
  const info = await infoFor(safe, abs);
  return { ...info, exists: true, content };
}

/** Delete one setup script. Returns whether a file was removed (false for unsafe/absent). */
export async function deleteSetupScript(name: string): Promise<boolean> {
  const abs = await resolveScript(name);
  if (!abs) return false;
  try {
    await unlink(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore one script to its bundled template, overwriting any edits. Returns the new
 * doc, or `null` if the name has no bundled template (nothing to restore to).
 */
export async function resetSetupScript(name: string): Promise<SetupScriptDoc | null> {
  const safe = safeName(name);
  if (!safe || !templateFor(safe)) return null;
  const content = await templateContent(safe);
  if (content == null) return null;
  return writeSetupScript(safe, content);
}
