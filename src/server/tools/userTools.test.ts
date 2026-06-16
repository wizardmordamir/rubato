import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../lib/apps';
import type { RubatoConfig } from '../../lib/config';
import { appliesToApp, buildHttpTool, type FetchLike, loadUserToolDefs, type UserToolDef } from './userTools';

const app = {
  name: 'myapp',
  group: 'work',
  absolutePath: '/repos/myapp',
  apis: [{ name: 'gitlab', baseUrl: 'https://gl.example' }],
} as unknown as AppConfig;
const cfg = {} as RubatoConfig;

describe('buildHttpTool', () => {
  afterEach(() => {
    delete process.env.TT;
  });

  test('interpolates url + headers from params, api base, and env secrets', async () => {
    process.env.TT = 's3cr3t';
    let seenUrl = '';
    let seenAuth = '';
    const fake: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization ?? '';
      return { ok: true, status: 200, text: async () => '{"id":1}' };
    };
    const def: UserToolDef = {
      name: 'get_project',
      description: 'fetch a project',
      type: 'http',
      params: [{ name: 'id', type: 'string', description: 'project id', required: true }],
      request: {
        url: '${api.gitlab.baseUrl}/projects/${id}?token=${env.TT}',
        headers: { Authorization: 'Bearer ${env.TT}' },
      },
    };
    const tool = buildHttpTool(def, cfg, fake);
    const res = await tool.run({ app }, { id: '42' });

    expect(seenUrl).toBe('https://gl.example/projects/42?token=s3cr3t');
    expect(seenAuth).toBe('Bearer s3cr3t');
    expect(res.ok).toBe(true);
    // The secret is redacted everywhere it would be shown to the model/UI.
    expect(res.content).toContain('token=***');
    expect(res.content).not.toContain('s3cr3t');
  });

  test('reports a non-2xx response as not ok', async () => {
    const fake: FetchLike = async () => ({ ok: false, status: 404, text: async () => 'nope' });
    const tool = buildHttpTool(
      { name: 't', description: 'd', type: 'http', request: { url: 'https://x/' } },
      cfg,
      fake,
    );
    const res = await tool.run({ app }, {});
    expect(res.ok).toBe(false);
    expect(res.content).toContain('HTTP 404');
  });

  test('surfaces transport failure instead of throwing', async () => {
    const fake: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const tool = buildHttpTool(
      { name: 't', description: 'd', type: 'http', request: { url: 'https://x/' } },
      cfg,
      fake,
    );
    const res = await tool.run({ app }, {});
    expect(res.ok).toBe(false);
    expect(res.content).toContain('request failed');
  });
});

describe('appliesToApp', () => {
  test('unscoped tools apply to every app', () => {
    expect(appliesToApp({ name: 't', description: 'd', type: 'http', request: { url: 'x' } }, app)).toBe(true);
  });
  test('scope matches name or group, case-insensitively', () => {
    const scoped = (s: string): UserToolDef => ({
      name: 't',
      description: 'd',
      type: 'http',
      appScope: s,
      request: { url: 'x' },
    });
    expect(appliesToApp(scoped('MyApp'), app)).toBe(true);
    expect(appliesToApp(scoped('work'), app)).toBe(true);
    expect(appliesToApp(scoped('other'), app)).toBe(false);
  });
});

describe('loadUserToolDefs', () => {
  test('loads valid defs and skips malformed/invalid ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-tools-'));
    await writeFile(
      join(dir, 'good.json'),
      JSON.stringify({ name: 'good', description: 'd', type: 'http', request: { url: 'https://x/' } }),
    );
    await writeFile(join(dir, 'bad-shape.json'), JSON.stringify({ name: 'nope', type: 'http' })); // no description/request
    await writeFile(join(dir, 'broken.json'), '{ not json');
    const defs = await loadUserToolDefs(dir);
    expect(defs.map((d) => d.name)).toEqual(['good']);
  });

  test('missing directory yields no tools', async () => {
    expect(await loadUserToolDefs(join(tmpdir(), 'rubato-does-not-exist-xyz'))).toEqual([]);
  });
});
