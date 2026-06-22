import { describe, expect, it } from 'bun:test';
import type { RenderSmokeResult } from '../../server/taskq/renderSmoke';
import { run } from '../../scripts/renderSmoke';
import { captureIo } from '../io';

const result = (over: Partial<RenderSmokeResult> = {}): RenderSmokeResult => ({
  repo: 'ru',
  ran: true,
  ok: true,
  detail: 'React root mounted (1200 bytes); no fatal console/page errors',
  durationMs: 123,
  ...over,
});

describe('rubato-render-smoke CLI (injected runner — no browser/server)', () => {
  it('exits 0 and prints GREEN on a clean render', async () => {
    const io = captureIo();
    const code = await run(['--port', '4901'], io, async () => result());
    expect(code).toBe(0);
    expect(io.out_()).toContain('GREEN');
  });

  it('exits 1 and prints RED + error detail on a white screen', async () => {
    const io = captureIo();
    const code = await run(['--port', '4902'], io, async () =>
      result({ ran: true, ok: false, detail: 'WHITE SCREEN — React root (#root) is empty after load', probe: { launched: true, navigated: true, rootFound: true, rootHtmlLength: 0, consoleErrors: ['Hook dispatcher is null'], pageErrors: [] } }),
    );
    expect(code).toBe(1);
    expect(io.out_()).toContain('RED');
    expect(io.err_()).toContain('Hook dispatcher is null');
  });

  it('exits 0 (lenient) when INCONCLUSIVE — no browser available', async () => {
    const io = captureIo();
    const code = await run(['--port', '4903'], io, async () => result({ ran: false, ok: false, detail: 'render check could not run: playwright not installed' }));
    expect(code).toBe(0);
    expect(io.err_()).toContain('INCONCLUSIVE');
  });

  it('exits 2 under --strict when INCONCLUSIVE', async () => {
    const io = captureIo();
    const code = await run(['--port', '4904', '--strict'], io, async () => result({ ran: false, ok: false, detail: 'no chrome' }));
    expect(code).toBe(2);
  });

  it('threads --cwd / --url / --root / --nav-timeout into the spec', async () => {
    let seen: { cwd: string; urlPath: string; rootSelector: string; navTimeoutMs: number } | undefined;
    const io = captureIo();
    await run(['--port', '4905', '--cwd', '/some/wt', '--url', '/apps', '--root', '#app', '--nav-timeout', '7000'], io, async (spec) => {
      seen = { cwd: spec.cwd, urlPath: spec.urlPath, rootSelector: spec.rootSelector, navTimeoutMs: spec.navTimeoutMs };
      return result();
    });
    expect(seen).toEqual({ cwd: '/some/wt', urlPath: '/apps', rootSelector: '#app', navTimeoutMs: 7000 });
  });
});
