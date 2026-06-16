/**
 * Vault API — an encrypted, master-password-gated credential store (the
 * single-user sibling of cursedalchemy's `/vault`).
 *
 *   GET    /api/vault/status         → { hasMaster, itemCount }
 *   POST   /api/vault/master         → set the master password the FIRST time → { token }
 *   POST   /api/vault/master/change  → change it when the current one is known → { token }
 *   POST   /api/vault/unlock         → exchange the master password for an unlock token → { token }
 *   GET    /api/vault/items          → VaultItem[]   (requires x-vault-token)
 *   POST   /api/vault/items          → create        (requires x-vault-token)
 *   PATCH  /api/vault/items/:id      → replace        (requires x-vault-token)
 *   DELETE /api/vault/items/:id      → { deleted }
 *
 * Security model (server-key + master gate — mirrors cursedalchemy):
 *   • Each item's content is encrypted AT REST with a SERVER-held key
 *     (`deriveKey(RUBATO_VAULT_SECRET, …)`), so a DB-only leak yields only
 *     ciphertext. The secret lives in ~/.rubato/.env (auto-generated on first use
 *     and persisted there), NEVER in the SQLite DB.
 *   • The MASTER PASSWORD is a SEPARATE gate that controls whether the API will
 *     decrypt at all — so a left-open session can't reveal/export secrets without
 *     re-entering it. Unlocking mints a short-lived (15-min) token the client
 *     keeps only in memory and sends back as `x-vault-token`.
 *
 * There is NO email reset here (unlike cursedalchemy): rubato is single-user and
 * loopback-only, so the recovery-by-email path doesn't apply. Forgetting the
 * master password without a backup means the gate can only be reset by editing
 * the DB directly — the deliberate single-user tradeoff.
 */

import { randomBytes } from 'node:crypto';
import { decryptSecret, deriveKey, encryptSecret, safeEqual } from 'cwip/node';
import { optionalEnv, setEnvVar } from '../api/env';
import type { VaultField, VaultItem, VaultItemInput } from '../shared/vault';
import {
  countVaultItems,
  deleteVaultRow,
  getVaultMaster,
  insertVaultRow,
  listVaultRows,
  saveVaultMaster,
  updateVaultRow,
  type VaultItemRow,
} from './db';
import { json, jsonError, readJsonBody } from './http';

const MIN_MASTER_LEN = 8;
const UNLOCK_TTL_MS = 15 * 60 * 1000; // a vault unlock lasts 15 minutes
const TOKEN_PURPOSE = 'vault-unlock';
const VAULT_SECRET_ENV = 'RUBATO_VAULT_SECRET';

// The server-held base secret for at-rest encryption. Read from the env (process
// env or ~/.rubato/.env); if absent, generate a strong random one and persist it
// to ~/.rubato/.env — OUTSIDE the SQLite DB — so a DB-only leak stays ciphertext.
// Cached after first resolution (it never changes within a process).
let cachedSecret: string | null = null;
function vaultServerSecret(): string {
  if (cachedSecret) return cachedSecret;
  const existing = optionalEnv(VAULT_SECRET_ENV);
  if (existing) {
    cachedSecret = existing;
    return existing;
  }
  const generated = randomBytes(32).toString('hex');
  setEnvVar(VAULT_SECRET_ENV, generated);
  cachedSecret = generated;
  return generated;
}

// Distinct derived keys: one for item encryption, one for unlock tokens.
const itemKey = () => deriveKey(vaultServerSecret(), 'vault:items');
const tokenKey = () => deriveKey(vaultServerSecret(), 'vault:unlock-token');

// ── Master-password gate (unlock token) ──────────────────────────────────────

// scrypt (via cwip `deriveKey`) is a proper password KDF, so we reuse it to hash
// the master password; `safeEqual` is the constant-time compare.
const hashMaster = (password: string, salt: string): string => deriveKey(password, salt).toString('hex');
const masterMatches = (password: string, salt: string, hash: string): boolean =>
  safeEqual(hashMaster(password, salt), hash);

// An unlock token is an AES-256-GCM-sealed `{ purpose, exp }` (tamper-proof, no
// JWT dependency needed) the client holds in memory and returns as x-vault-token.
const signUnlockToken = (): string =>
  encryptSecret(JSON.stringify({ purpose: TOKEN_PURPOSE, exp: Date.now() + UNLOCK_TTL_MS }), tokenKey());

const isUnlocked = (req: Request): boolean => {
  const token = req.headers.get('x-vault-token');
  if (!token) return false;
  try {
    const claims = JSON.parse(decryptSecret(token, tokenKey())) as { purpose?: string; exp?: number };
    return claims.purpose === TOKEN_PURPOSE && typeof claims.exp === 'number' && claims.exp > Date.now();
  } catch {
    return false;
  }
};

// ── Item body (the encrypted shape — everything but id/timestamps) ────────────

type VaultItemBody = Omit<VaultItem, 'id' | 'createdAt' | 'updatedAt'>;

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function cleanBody(b: unknown): VaultItemBody | null {
  const body = b as Record<string, unknown> | null;
  if (!body || typeof body.title !== 'string' || !body.title.trim()) return null;
  const fields: VaultField[] = Array.isArray(body.fields)
    ? body.fields
        .filter(
          (f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as any).label === 'string',
        )
        .map((f) => ({ label: String(f.label), value: String(f.value ?? ''), secret: !!f.secret }))
        .slice(0, 50)
    : [];
  return {
    title: body.title.trim(),
    link: asStr(body.link),
    username: asStr(body.username),
    description: asStr(body.description),
    notes: asStr(body.notes),
    password: asStr(body.password),
    fields,
  };
}

const decryptRow = (r: VaultItemRow): VaultItem => ({
  id: r.id,
  ...(JSON.parse(decryptSecret(r.data, itemKey())) as VaultItemBody),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// ── Handlers ──────────────────────────────────────────────────────────────────

// GET /api/vault/status — drives the locked UI.
const handleStatus = (): Response => json({ hasMaster: getVaultMaster() != null, itemCount: countVaultItems() });

// POST /api/vault/master — set the master password the first time (409 if set).
async function handleSetMaster(req: Request): Promise<Response> {
  if (getVaultMaster()) return jsonError('A vault password is already set.', 409);
  const body = await readJsonBody<{ masterPassword?: string }>(req);
  const master = body?.masterPassword;
  if (typeof master !== 'string' || master.length < MIN_MASTER_LEN) {
    return jsonError(`Vault password must be at least ${MIN_MASTER_LEN} characters.`, 400);
  }
  const salt = randomBytes(16).toString('hex');
  saveVaultMaster(hashMaster(master, salt), salt);
  return json({ token: signUnlockToken() }, 201);
}

// POST /api/vault/unlock — exchange the master password for an unlock token.
async function handleUnlock(req: Request): Promise<Response> {
  const master = getVaultMaster();
  if (!master) return jsonError('No vault password set yet.', 409);
  const body = await readJsonBody<{ masterPassword?: string }>(req);
  const pw = body?.masterPassword;
  if (typeof pw !== 'string' || !masterMatches(pw, master.salt, master.hash)) {
    return jsonError('Incorrect vault password.', 401);
  }
  return json({ token: signUnlockToken() });
}

// POST /api/vault/master/change — change the master password when the current
// one is known. Items are unaffected (server-key encryption).
async function handleChangeMaster(req: Request): Promise<Response> {
  const master = getVaultMaster();
  if (!master) return jsonError('No vault password set yet.', 409);
  const body = await readJsonBody<{ currentPassword?: string; newPassword?: string }>(req);
  if (typeof body?.currentPassword !== 'string' || !masterMatches(body.currentPassword, master.salt, master.hash)) {
    return jsonError('Current vault password is incorrect.', 401);
  }
  if (typeof body?.newPassword !== 'string' || body.newPassword.length < MIN_MASTER_LEN) {
    return jsonError(`New vault password must be at least ${MIN_MASTER_LEN} characters.`, 400);
  }
  const salt = randomBytes(16).toString('hex');
  saveVaultMaster(hashMaster(body.newPassword, salt), salt);
  return json({ token: signUnlockToken() });
}

// GET /api/vault/items — decrypt + return all items (requires unlock).
const handleListItems = (req: Request): Response =>
  isUnlocked(req) ? json(listVaultRows().map(decryptRow)) : jsonError('Vault is locked.', 401);

// POST /api/vault/items — create (requires unlock).
async function handleCreateItem(req: Request): Promise<Response> {
  if (!isUnlocked(req)) return jsonError('Vault is locked.', 401);
  const body = cleanBody(await readJsonBody<VaultItemInput>(req));
  if (!body) return jsonError('A title is required.', 400);
  const { id, createdAt, updatedAt } = insertVaultRow(encryptSecret(JSON.stringify(body), itemKey()));
  return json({ id, ...body, createdAt, updatedAt } satisfies VaultItem, 201);
}

// PATCH /api/vault/items/:id — replace an item's content (requires unlock).
async function handleUpdateItem(req: Request, id: string): Promise<Response> {
  if (!isUnlocked(req)) return jsonError('Vault is locked.', 401);
  const body = cleanBody(await readJsonBody<VaultItemInput>(req));
  if (!body) return jsonError('A title is required.', 400);
  const res = updateVaultRow(id, encryptSecret(JSON.stringify(body), itemKey()));
  if (!res) return jsonError('vault item not found', 404);
  // createdAt is unchanged; the client refetches the list, so a partial item is fine.
  return json({ id, ...body, updatedAt: res.updatedAt });
}

// DELETE /api/vault/items/:id — delete (no unlock needed; no decryption involved).
const handleDeleteItem = (id: string): Response =>
  deleteVaultRow(id) ? json({ deleted: true }) : jsonError('vault item not found', 404);

export async function handleVaultApi(pathname: string, req: Request): Promise<Response> {
  const m = req.method;
  if (pathname === '/api/vault/status') {
    return m === 'GET' ? handleStatus() : jsonError('use GET', 405);
  }
  if (pathname === '/api/vault/master') {
    return m === 'POST' ? handleSetMaster(req) : jsonError('use POST', 405);
  }
  if (pathname === '/api/vault/master/change') {
    return m === 'POST' ? handleChangeMaster(req) : jsonError('use POST', 405);
  }
  if (pathname === '/api/vault/unlock') {
    return m === 'POST' ? handleUnlock(req) : jsonError('use POST', 405);
  }
  if (pathname === '/api/vault/items') {
    if (m === 'GET') return handleListItems(req);
    if (m === 'POST') return handleCreateItem(req);
    return jsonError('use GET or POST', 405);
  }
  if (pathname.startsWith('/api/vault/items/')) {
    const id = decodeURIComponent(pathname.slice('/api/vault/items/'.length));
    if (m === 'PATCH') return handleUpdateItem(req, id);
    if (m === 'DELETE') return handleDeleteItem(id);
    return jsonError('use PATCH or DELETE', 405);
  }
  return jsonError(`not found: ${pathname}`, 404);
}
