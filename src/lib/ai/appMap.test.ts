import { describe, expect, test } from 'bun:test';
import { buildAppMap } from './appMap';

describe('buildAppMap', () => {
  const files = [
    {
      relativePath: 'ui/src/pages/routes.tsx',
      content: `<Route path="/private" element={<PrivatePage/>} />\n<Route path="/links" element={<Links/>} />`,
    },
    {
      relativePath: 'server/src/routes/private.ts',
      content: `router.get('/private/:id', handler)\nrouter.post('/private', create)`,
    },
    { relativePath: 'server/src/routes/build.ts', content: `buildRoutes('delete', '/private/:id', guard, remove)` },
    { relativePath: 'README.md', content: 'not a source file, ignored for routes' },
  ];

  test('extracts UI routes, server endpoints, and a directory tree', () => {
    const md = buildAppMap(files);
    expect(md).toContain('/private');
    expect(md).toContain('/links');
    expect(md).toContain('GET /private/:id');
    expect(md).toContain('POST /private');
    expect(md).toContain('DELETE /private/:id'); // buildRoutes twin
    expect(md).toContain('ui/'); // directory tree
    expect(md).toContain('### App map');
  });

  test('dedups and sorts routes', () => {
    const md = buildAppMap([
      { relativePath: 'a.tsx', content: `path="/x" path="/x" path="/a"` },
    ]);
    const idxA = md.indexOf('/a');
    const idxX = md.indexOf('/x');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxX); // sorted: /a before /x
    expect(md.match(/- \/x/g)?.length).toBe(1); // deduped
  });

  test('captures routes declared as constants (path: fooRoute)', () => {
    const md = buildAppMap([
      { relativePath: 'ui/src/pages/routeMeta.ts', content: `export const privateMediaRoute = '/private';` },
      { relativePath: 'ui/src/pages/Profile.tsx', content: `export const pageRoute = "/profile";` },
    ]);
    expect(md).toContain('/private');
    expect(md).toContain('/profile');
  });

  test('returns empty string when nothing structural is found', () => {
    expect(buildAppMap([{ relativePath: 'notes.txt', content: 'hello world' }])).toBe('');
  });

  test('honors the token budget (truncates)', () => {
    const big = { relativePath: 'a.tsx', content: Array.from({ length: 500 }, (_, i) => `path="/r${i}"`).join('\n') };
    const md = buildAppMap([big], { maxTokens: 50 });
    expect(md.length).toBeLessThanOrEqual(50 * 4 + 40);
    expect(md).toContain('truncated');
  });
});
