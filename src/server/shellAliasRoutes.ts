/**
 * Shell alias API: a per-machine catalogue of shell aliases that can be applied
 * to the system shell config or exported to cursedalchemy.
 *
 *   GET    /api/shell-aliases           → ShellAlias[]
 *   POST   /api/shell-aliases           → create (body: { name, command, description?, tags? })
 *   PATCH  /api/shell-aliases/:id       → partial update
 *   DELETE /api/shell-aliases/:id       → { deleted }
 *   GET    /api/shell-aliases/export.sh → download as shell script
 *   GET    /api/shell-aliases/export.json → download as JSON (ca format)
 *   GET    /api/shell-aliases/shell-configs → detect ~/.zshrc, ~/.bash_profile, ~/.bashrc
 *   POST   /api/shell-aliases/apply     → write ~/.rubato-user-aliases.sh + optionally source it
 *   POST   /api/shell-aliases/import    → import aliases from a ca JSON export
 */

import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createShellAlias,
  deleteShellAlias,
  importShellAliases,
  listShellAliases,
  updateShellAlias,
} from './db';
import { json, jsonError, readJsonBody } from './http';

const ALIASES_FILE = join(homedir(), '.rubato-user-aliases.sh');

const SHELL_CONFIGS = [
  { file: '.zshrc', label: 'Zsh (~/.zshrc)' },
  { file: '.bash_profile', label: 'Bash profile (~/.bash_profile)' },
  { file: '.bashrc', label: 'Bash rc (~/.bashrc)' },
  { file: '.profile', label: 'POSIX profile (~/.profile)' },
];

function sourceLineFor(file: string): string {
  return `\n# Rubato user aliases\n[ -f "${file}" ] && source "${file}"\n`;
}

function buildShellScript(aliases: ReturnType<typeof listShellAliases>): string {
  const lines = [
    '# Rubato user aliases — auto-generated, do not edit by hand.',
    `# Generated: ${new Date().toISOString()}`,
    '',
    ...aliases.map((a) => {
      const escaped = a.command.replace(/'/g, "'\\''");
      const comment = a.description ? `# ${a.description}\n` : '';
      return `${comment}alias ${a.name}='${escaped}'`;
    }),
  ];
  return `${lines.join('\n')}\n`;
}

export async function handleShellAliasApi(pathname: string, req: Request): Promise<Response> {
  // ── List ──────────────────────────────────────────────────────────────────
  if (pathname === '/api/shell-aliases' && req.method === 'GET') {
    return json(listShellAliases());
  }

  // ── Download as .sh ───────────────────────────────────────────────────────
  if (pathname === '/api/shell-aliases/export.sh' && req.method === 'GET') {
    const script = buildShellScript(listShellAliases());
    return new Response(script, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="aliases-export-${new Date().toISOString().slice(0, 10)}.sh"`,
      },
    });
  }

  // ── Download as JSON (ca-compatible export format) ────────────────────────
  if (pathname === '/api/shell-aliases/export.json' && req.method === 'GET') {
    const aliases = listShellAliases();
    return new Response(JSON.stringify({ aliases, exportedAt: new Date().toISOString() }, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="aliases-export-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  }

  // ── Detect shell config files ──────────────────────────────────────────────
  if (pathname === '/api/shell-aliases/shell-configs' && req.method === 'GET') {
    const home = homedir();
    const configs = SHELL_CONFIGS.map(({ file, label }) => ({
      file,
      label,
      path: join(home, file),
      exists: existsSync(join(home, file)),
    }));
    const aliasFileExists = existsSync(ALIASES_FILE);
    return json({ configs, aliasFile: ALIASES_FILE, aliasFileExists });
  }

  // ── Apply aliases to system shell config ─────────────────────────────────
  if (pathname === '/api/shell-aliases/apply' && req.method === 'POST') {
    const body = await readJsonBody<{ configFile?: string }>(req);
    const aliases = listShellAliases();

    // Always write the aliases file.
    await writeFile(ALIASES_FILE, buildShellScript(aliases), 'utf8');

    // Optionally add a source line to the chosen config file.
    if (body?.configFile) {
      const home = homedir();
      const allowed = SHELL_CONFIGS.map((c) => c.file);
      if (!allowed.includes(body.configFile)) {
        return jsonError('invalid configFile', 400);
      }
      const configPath = join(home, body.configFile);
      const sourceLine = sourceLineFor(ALIASES_FILE);
      if (existsSync(configPath)) {
        const existing = await readFile(configPath, 'utf8');
        if (!existing.includes(ALIASES_FILE)) {
          await appendFile(configPath, sourceLine, 'utf8');
        }
      } else {
        await writeFile(configPath, sourceLine, 'utf8');
      }
    }

    return json({ applied: aliases.length, aliasFile: ALIASES_FILE });
  }

  // ── Import from ca JSON export ────────────────────────────────────────────
  if (pathname === '/api/shell-aliases/import' && req.method === 'POST') {
    const body = await readJsonBody<{ aliases?: unknown[] }>(req);
    if (!body?.aliases || !Array.isArray(body.aliases)) {
      return jsonError('expected { aliases: [...] } body', 400);
    }
    const valid = body.aliases.filter(
      (a): a is { name: string; command: string; description?: string; tags?: string } =>
        typeof (a as any).name === 'string' && typeof (a as any).command === 'string',
    );
    const result = importShellAliases(valid);
    return json(result);
  }

  // ── Create ────────────────────────────────────────────────────────────────
  if (pathname === '/api/shell-aliases' && req.method === 'POST') {
    const body = await readJsonBody<{ name?: string; command?: string; description?: string; tags?: string }>(req);
    if (!body?.name?.trim()) return jsonError('name is required', 400);
    if (!body?.command?.trim()) return jsonError('command is required', 400);
    const alias = createShellAlias({ name: body.name.trim(), command: body.command, description: body.description, tags: body.tags });
    return json(alias, 201);
  }

  // ── Update ────────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/shell-aliases/') && req.method === 'PATCH') {
    const id = decodeURIComponent(pathname.slice('/api/shell-aliases/'.length));
    const body = await readJsonBody<{ name?: string; command?: string; description?: string; tags?: string }>(req);
    const updated = updateShellAlias(id, body ?? {});
    if (!updated) return jsonError('alias not found', 404);
    return json(updated);
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/shell-aliases/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/shell-aliases/'.length));
    const deleted = deleteShellAlias(id);
    if (!deleted) return jsonError('alias not found', 404);
    return json({ deleted: id });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
