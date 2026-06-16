import { describe, expect, test } from 'bun:test';
import { COMMANDS } from '../commands';
import { route } from './router';

describe('server router', () => {
  test('GET / serves the HTML UI', async () => {
    const res = await route(new Request('http://x/'));
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<title>Rubato</title>');
  });

  test('GET /api/commands returns the command registry', async () => {
    const res = await route(new Request('http://x/api/commands'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ name: string }>;
    expect(data.length).toBe(COMMANDS.length);
    expect(data.some((c) => c.name === 'goto')).toBe(true);
  });

  test('GET /api/apps returns an array', async () => {
    const res = await route(new Request('http://x/api/apps'));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/apps/:name/details 404s for an unknown app, and 404s without the /details suffix', async () => {
    const res = await route(new Request('http://x/api/apps/__no_such_app__/details'));
    expect(res.status).toBe(404);
    // Canonical error envelope, shared across the apps: { error: { name, message, status, … } }.
    const body = (await res.json()) as { error: { message: string; status: number; code?: string } };
    expect(body.error.status).toBe(404);
    expect(typeof body.error.message).toBe('string');
    expect((await route(new Request('http://x/api/apps/whatever'))).status).toBe(404);
  });

  test('GET /api/health reports ok with counts', async () => {
    const health = (await (await route(new Request('http://x/api/health'))).json()) as {
      ok: boolean;
      commands: number;
    };
    expect(health.ok).toBe(true);
    expect(health.commands).toBe(COMMANDS.length);
  });

  test('POST /api/run rejects an unknown command', async () => {
    const res = await route(
      new Request('http://x/api/run', { method: 'POST', body: JSON.stringify({ command: 'nope' }) }),
    );
    expect(res.status).toBe(400);
  });

  test('GET /api/archives returns an array', async () => {
    const res = await route(new Request('http://x/api/archives'));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('POST /api/archive without a command is a 400', async () => {
    const res = await route(new Request('http://x/api/archive', { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });

  test('DELETE /api/archives/:id rejects a non-numeric id', async () => {
    const res = await route(new Request('http://x/api/archives/abc', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  test('unknown API path 404s; unknown non-API path falls back to the UI (SPA)', async () => {
    expect((await route(new Request('http://x/api/nope'))).status).toBe(404);
    expect((await route(new Request('http://x/some/spa/route'))).status).toBe(200);
  });

  test('GET /api/docs lists root docs plus the generated cheatsheet', async () => {
    const res = await route(new Request('http://x/api/docs'));
    expect(res.status).toBe(200);
    const docs = (await res.json()) as string[];
    expect(docs).toContain('OVERVIEW.md');
    expect(docs[0]).toBe('OVERVIEW.md'); // root docs come first
    expect(docs).toContain('commands-by-example.md'); // generated live from the registry
  });

  test('GET /api/docs/:name returns markdown for a root doc and the generated doc', async () => {
    const root = await route(new Request('http://x/api/docs/OVERVIEW.md'));
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/markdown');
    expect((await root.text()).length).toBeGreaterThan(0);

    const gen = await route(new Request('http://x/api/docs/commands-by-example.md'));
    expect(gen.status).toBe(200);
    expect(gen.headers.get('content-type')).toContain('text/markdown');
    expect(await gen.text()).toContain('# Commands by example'); // rendered, not from disk
  });

  test('GET /api/docs/:name rejects a non-allowlisted path (no traversal)', async () => {
    expect((await route(new Request('http://x/api/docs/package.json'))).status).toBe(404);
    expect((await route(new Request('http://x/api/docs/..%2F..%2Fetc%2Fpasswd'))).status).toBe(404);
  });

  test('GET /api/files returns an array of output files', async () => {
    const res = await route(new Request('http://x/api/files'));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/files/content needs a path and refuses traversal', async () => {
    expect((await route(new Request('http://x/api/files/content'))).status).toBe(400);
    expect((await route(new Request('http://x/api/files/content?path=..%2F..%2Fetc%2Fpasswd'))).status).toBe(403);
  });

  test('GET /api/files/raw serves images inline and sandboxes captured HTML', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { ensureOutputDir } = await import('../lib/runStore');
    const dir = await ensureOutputDir();
    await writeFile(resolve(dir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex')); // PNG magic
    await writeFile(resolve(dir, 'dom.html'), '<html><body>captured</body></html>', 'utf8');

    const png = await route(new Request('http://x/api/files/raw?path=shot.png'));
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toContain('inline');

    const html = await route(new Request('http://x/api/files/raw?path=dom.html'));
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('content-security-policy')).toBe('sandbox'); // inline scripts can't run
    expect(await html.text()).toContain('captured');
  });

  test('GET /api/files/raw needs a path and refuses traversal', async () => {
    expect((await route(new Request('http://x/api/files/raw'))).status).toBe(400);
    expect((await route(new Request('http://x/api/files/raw?path=..%2F..%2Fetc%2Fpasswd'))).status).toBe(403);
  });

  test('GET /api/ui resolves page toggles (apps on by default) + an admin flag', async () => {
    const res = await route(new Request('http://x/api/ui'));
    expect(res.status).toBe(200);
    const ui = (await res.json()) as { pages: Record<string, boolean>; admin: boolean };
    expect(ui.pages.apps).toBe(true); // apps is the one default-on page
    expect(typeof ui.admin).toBe('boolean');
  });

  test('POST /api/ui rejects a malformed body before touching config', async () => {
    const res = await route(new Request('http://x/api/ui', { method: 'POST', body: '{not json' }));
    expect(res.status).toBe(400);
  });

  test('unknown /api/admin path 404s (and the surface is gated when admin is off)', async () => {
    expect((await route(new Request('http://x/api/admin/__nope__'))).status).toBe(404);
  });

  test('system-files: list, GET reads, POST writes the CLAUDE.md entry (isolated via CLAUDE_CONFIG_DIR)', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const prev = process.env.CLAUDE_CONFIG_DIR;
    const dir = await mkdtemp(join(tmpdir(), 'rubato-sysfiles-router-'));
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      const list = (await (await route(new Request('http://x/api/system-files'))).json()) as {
        key: string;
        markdown: boolean;
      }[];
      expect(list.some((f) => f.key === 'claude' && f.markdown)).toBe(true);
      expect(list.some((f) => f.key === 'zshrc')).toBe(true);

      const before = (await (await route(new Request('http://x/api/system-files/claude'))).json()) as {
        exists: boolean;
      };
      expect(before.exists).toBe(false);

      const post = await route(
        new Request('http://x/api/system-files/claude', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: '# global' }),
        }),
      );
      expect(post.status).toBe(200);
      expect(((await post.json()) as { content: string }).content).toBe('# global');

      const after = (await (await route(new Request('http://x/api/system-files/claude'))).json()) as {
        exists: boolean;
        content: string;
      };
      expect(after.exists).toBe(true);
      expect(after.content).toBe('# global');

      // A bad body 400s; an unknown key 404s (no path-traversal surface).
      const bad = await route(
        new Request('http://x/api/system-files/claude', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nope: 1 }),
        }),
      );
      expect(bad.status).toBe(400);
      expect((await route(new Request('http://x/api/system-files/__nope__'))).status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('every response carries an x-correlation-id header (minted when absent)', async () => {
    const res = await route(new Request('http://x/api/health'));
    const id = res.headers.get('x-correlation-id');
    expect(typeof id).toBe('string');
    expect((id ?? '').length).toBeGreaterThan(0);
    // an error response is stamped too
    const err = await route(new Request('http://x/api/nope'));
    expect(err.status).toBe(404);
    expect((err.headers.get('x-correlation-id') ?? '').length).toBeGreaterThan(0);
  });

  test('reuses an inbound x-correlation-id header', async () => {
    const res = await route(new Request('http://x/api/health', { headers: { 'x-correlation-id': 'trace-123' } }));
    expect(res.headers.get('x-correlation-id')).toBe('trace-123');
  });
});
