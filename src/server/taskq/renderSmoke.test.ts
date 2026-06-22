import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_IGNORE_CONSOLE,
  type RenderProbe,
  RENDER_PROBE_SENTINEL,
  type RenderSmokeSpec,
  caRenderSmokeSpec,
  decideRender,
  isIgnoredConsole,
  parseProbe,
  planRenderSmoke,
  renderSmokeEnv,
  renderSmokeHomeDir,
  runRenderSmoke,
  rubatoRenderSmokeSpec,
} from './renderSmoke';

const baseSpec = (over: Partial<RenderSmokeSpec> = {}): RenderSmokeSpec =>
  planRenderSmoke({ repo: 'ru', cmd: ['bun', 'x'], cwd: '/wt', port: 9999, homeDir: '/tmp/h', homeEnvVar: 'RUBATO_HOME', portEnvVar: 'RUBATO_PORT', ...over });

const probe = (over: Partial<RenderProbe> = {}): RenderProbe => ({
  launched: true,
  navigated: true,
  rootFound: true,
  rootHtmlLength: 1200,
  consoleErrors: [],
  pageErrors: [],
  ...over,
});

describe('planRenderSmoke', () => {
  it('fills sensible defaults', () => {
    const s = baseSpec();
    expect(s.healthPath).toBe('/api/health');
    expect(s.urlPath).toBe('/');
    expect(s.rootSelector).toBe('#root');
    expect(s.navTimeoutMs).toBe(20_000);
    expect(s.timeoutMs).toBe(45_000);
    expect(s.ignoreConsole).toEqual(DEFAULT_IGNORE_CONSOLE);
  });
  it('respects overrides', () => {
    const s = baseSpec({ urlPath: '/apps', rootSelector: '#app', navTimeoutMs: 5_000, ignoreConsole: ['x'] });
    expect(s.urlPath).toBe('/apps');
    expect(s.rootSelector).toBe('#app');
    expect(s.navTimeoutMs).toBe(5_000);
    expect(s.ignoreConsole).toEqual(['x']);
  });
});

describe('renderSmokeEnv', () => {
  it('maps the isolation knobs + extras', () => {
    const s = baseSpec({ extraEnv: { NODE_ENV: 'production' } });
    expect(renderSmokeEnv(s)).toEqual({ RUBATO_HOME: '/tmp/h', RUBATO_PORT: '9999', NODE_ENV: 'production' });
  });
});

describe('presets', () => {
  it('rubatoRenderSmokeSpec boots rubato-serve with RUBATO_HOME/PORT and builds the SPA first', () => {
    const s = rubatoRenderSmokeSpec({ cwd: '/ru-int', port: 4801, homeDir: '/tmp/ru' });
    expect(s.repo).toBe('ru');
    expect(s.buildCmd).toEqual(['bun', 'run', 'web:build']); // gate's `bun run build` doesn't build the UI
    expect(s.cmd).toEqual(['bun', 'run', 'src/scripts/serve.ts']);
    expect(s.homeEnvVar).toBe('RUBATO_HOME');
    expect(s.portEnvVar).toBe('RUBATO_PORT');
  });
  it('caRenderSmokeSpec defaults to ca env vars and is overridable', () => {
    const s = caRenderSmokeSpec({ cwd: '/ca-int', port: 4802, homeDir: '/tmp/ca' });
    expect(s.repo).toBe('ca');
    expect(s.homeEnvVar).toBe('CA_DATA_DIR');
    const o = caRenderSmokeSpec({ cwd: '/ca-int', port: 4802, homeDir: '/tmp/ca', homeEnvVar: 'CA_HOME', cmd: ['node', 'server.mjs'] });
    expect(o.homeEnvVar).toBe('CA_HOME');
    expect(o.cmd).toEqual(['node', 'server.mjs']);
  });
});

describe('isIgnoredConsole', () => {
  it('matches case-insensitive substrings', () => {
    expect(isIgnoredConsole('Failed to load resource: /favicon.ico', ['favicon'])).toBe(true);
    expect(isIgnoredConsole('Uncaught TypeError: x is not a function', ['favicon'])).toBe(false);
    expect(isIgnoredConsole('anything', [''])).toBe(false); // empty pattern never matches
  });
});

describe('decideRender — the white-screen ladder', () => {
  const spec = { rootSelector: '#root', ignoreConsole: DEFAULT_IGNORE_CONSOLE };

  it('a clean mount is GREEN + ran', () => {
    const v = decideRender(probe(), spec);
    expect(v).toMatchObject({ ran: true, ok: true });
    expect(v.detail).toContain('mounted');
  });

  it('an empty root is a WHITE SCREEN (ran + red)', () => {
    const v = decideRender(probe({ rootFound: true, rootHtmlLength: 0 }), spec);
    expect(v).toMatchObject({ ran: true, ok: false });
    expect(v.detail).toContain('WHITE SCREEN');
    expect(v.detail).toContain('empty');
  });

  it('a missing root is a WHITE SCREEN', () => {
    const v = decideRender(probe({ rootFound: false, rootHtmlLength: 0 }), spec);
    expect(v).toMatchObject({ ran: true, ok: false });
    expect(v.detail).toContain('missing');
  });

  it('a fatal pageerror reds a mounted app', () => {
    const v = decideRender(probe({ pageErrors: ['TypeError: dispatcher is null'] }), spec);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('TypeError');
  });

  it('a fatal console error reds; ignored console noise does not', () => {
    expect(decideRender(probe({ consoleErrors: ['Hook called outside a component'] }), spec).ok).toBe(false);
    const benign = decideRender(probe({ consoleErrors: ['Failed to load resource: /favicon.ico'] }), spec);
    expect(benign.ok).toBe(true);
    expect(benign.fatalConsole).toEqual([]);
  });

  it('a browser that never launched is INCONCLUSIVE (ran:false), never a failure to block on', () => {
    const v = decideRender(probe({ launched: false, error: 'playwright not installed' }), spec);
    expect(v).toMatchObject({ ran: false, ok: false });
    expect(v.detail).toContain('could not run');
  });

  it('launched but never navigated is RED (ran:true)', () => {
    const v = decideRender(probe({ navigated: false, error: 'net::ERR_CONNECTION_REFUSED' }), spec);
    expect(v).toMatchObject({ ran: true, ok: false });
    expect(v.detail).toContain('never loaded');
  });
});

describe('parseProbe', () => {
  it('reads the sentinel line amid noise', () => {
    const stdout = `some log\n${RENDER_PROBE_SENTINEL}${JSON.stringify({ launched: true, navigated: true, rootFound: true, rootHtmlLength: 42, consoleErrors: ['a'], pageErrors: [] })}\ntrailing`;
    const p = parseProbe(stdout);
    expect(p).toMatchObject({ launched: true, navigated: true, rootHtmlLength: 42, consoleErrors: ['a'] });
  });
  it('returns an inconclusive probe with the stderr tail when no line is emitted', () => {
    const p = parseProbe('nothing useful', 'boom: host crashed');
    expect(p.launched).toBe(false);
    expect(p.error).toContain('no render result emitted');
    expect(p.error).toContain('host crashed');
  });
  it('coerces missing/odd fields safely', () => {
    const p = parseProbe(`${RENDER_PROBE_SENTINEL}{"launched":true}`);
    expect(p).toMatchObject({ launched: true, navigated: false, rootHtmlLength: 0, consoleErrors: [], pageErrors: [] });
  });
});

describe('runRenderSmoke (injected deps — no real browser/server)', () => {
  const fakeServer = () => ({ logs: () => ['listening on 9999', 'ready'], stop: async () => {} });
  const deps = (over: Parameters<typeof runRenderSmoke>[1] = {}) => ({
    startServer: async () => fakeServer(),
    ensureDir: async () => {},
    removeDir: async () => {},
    now: () => 0,
    ...over,
  });

  it('GREEN when the server boots and the page renders clean', async () => {
    const r = await runRenderSmoke(baseSpec(), deps({ runProbe: async () => probe() }));
    expect(r).toMatchObject({ repo: 'ru', ran: true, ok: true });
    expect(r.logTail).toContain('ready');
  });

  it('RED on a white screen (root empty)', async () => {
    const r = await runRenderSmoke(baseSpec(), deps({ runProbe: async () => probe({ rootHtmlLength: 0 }) }));
    expect(r).toMatchObject({ ran: true, ok: false });
    expect(r.detail).toContain('WHITE SCREEN');
  });

  it('INCONCLUSIVE (ran:false) when the server never boots — does NOT mark a white screen', async () => {
    const r = await runRenderSmoke(
      baseSpec(),
      deps({
        startServer: async () => {
          throw new Error('boot timed out');
        },
        runProbe: async () => {
          throw new Error('should not probe');
        },
      }),
    );
    expect(r).toMatchObject({ ran: false, ok: false });
    expect(r.detail).toContain('did not boot');
  });

  it('INCONCLUSIVE when no browser is available (probe launched:false)', async () => {
    const r = await runRenderSmoke(baseSpec(), deps({ runProbe: async () => probe({ launched: false, error: 'no chrome' }) }));
    expect(r).toMatchObject({ ran: false, ok: false });
  });

  it('always tears the server + home dir down (even on a probe throw)', async () => {
    let stopped = false;
    let removed = false;
    const r = await runRenderSmoke(
      baseSpec(),
      deps({
        startServer: async () => ({ logs: () => [], stop: async () => { stopped = true; } }),
        removeDir: async () => { removed = true; },
        runProbe: async () => { throw new Error('probe blew up'); },
      }),
    );
    expect(stopped).toBe(true);
    expect(removed).toBe(true);
    expect(r.ran).toBe(false); // a probe throw is inconclusive, not a proven white screen
  });

  // ── the pre-boot UI build (the gate's `bun run build` doesn't build the SPA) ──
  const buildSpec = () => baseSpec({ buildCmd: ['bun', 'run', 'web:build'] });

  it('builds the SPA before booting when buildCmd is set, then renders', async () => {
    let builtIn: string | undefined;
    const r = await runRenderSmoke(
      buildSpec(),
      deps({ runBuild: async (_cmd, cwd) => { builtIn = cwd; return { code: 0, output: 'built' }; }, runProbe: async () => probe() }),
    );
    expect(builtIn).toBe('/wt'); // built in the integration worktree dir
    expect(r).toMatchObject({ ran: true, ok: true });
  });

  it('a FAILING UI build is RED (ran:true) — a bundle that wont compile cant render', async () => {
    let probed = false;
    const r = await runRenderSmoke(
      buildSpec(),
      deps({
        runBuild: async () => ({ code: 1, output: 'TS2304: Cannot find name X' }),
        runProbe: async () => { probed = true; return probe(); },
      }),
    );
    expect(r).toMatchObject({ ran: true, ok: false });
    expect(r.detail).toContain('UI build failed');
    expect(r.logTail).toContain('TS2304');
    expect(probed).toBe(false); // never boots/probes a UI that didn't build
  });

  it('a build that cannot be SPAWNED is INCONCLUSIVE (ran:false), never a false white screen', async () => {
    const r = await runRenderSmoke(
      buildSpec(),
      deps({ runBuild: async () => { throw new Error('ENOENT bun'); }, runProbe: async () => probe() }),
    );
    expect(r).toMatchObject({ ran: false, ok: false });
    expect(r.detail).toContain('could not run UI build');
  });
});

describe('renderSmokeHomeDir', () => {
  it('is an isolated, repo+seed-scoped tmp path', () => {
    const d = renderSmokeHomeDir('ru', 'abc');
    expect(d).toContain('intgate-render-ru-abc');
  });
});
