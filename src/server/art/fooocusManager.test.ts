import { describe, expect, test } from 'bun:test';
import { type FooocusServerStatus, fooocusServerView } from '../../shared/fooocus';
import { resolveFooocusSpec } from './fooocusManager';

/** Build an `exists` predicate from an explicit set of present paths. */
function existsFromSet(present: string[]): (p: string) => boolean {
  const set = new Set(present);
  return (p) => set.has(p);
}

describe('resolveFooocusSpec — discovery', () => {
  test('api: picks the first candidate whose entry script exists, and its venv python', () => {
    const dirs = ['/opt/missing/Fooocus-API', '/opt/real/Fooocus-API'];
    const spec = resolveFooocusSpec('api', undefined, {
      candidateDirs: dirs,
      exists: existsFromSet(['/opt/real/Fooocus-API/main.py', '/opt/real/Fooocus-API/.venv/bin/python3']),
    });
    expect(spec.dir).toBe('/opt/real/Fooocus-API');
    expect(spec.python).toBe('/opt/real/Fooocus-API/.venv/bin/python3');
    expect(spec.args).toEqual(['main.py']);
    expect(spec.port).toBe(8888);
    expect(spec.url).toBe('http://localhost:8888');
  });

  test('api: a candidate dir without the entry script (the empty stub) is skipped', () => {
    const spec = resolveFooocusSpec('api', undefined, {
      candidateDirs: ['/opt/stub/Fooocus-API', '/opt/real/Fooocus-API'],
      // stub dir exists but has NO main.py; only the second dir has the entry
      exists: existsFromSet(['/opt/real/Fooocus-API/main.py']),
    });
    expect(spec.dir).toBe('/opt/real/Fooocus-API');
  });

  test('not installed: no candidate has the entry → dir null, falls back to python3 (no throw)', () => {
    const spec = resolveFooocusSpec('api', undefined, {
      candidateDirs: ['/opt/a', '/opt/b'],
      exists: existsFromSet([]), // nothing on disk → simulates a deleted Fooocus
    });
    expect(spec.dir).toBeNull();
    expect(spec.python).toBe('python3');
  });

  test('ui: launch args include --port; borrows the API venv python when it has none', () => {
    const spec = resolveFooocusSpec('ui', undefined, {
      candidateDirs: ['/opt/real/Fooocus'],
      exists: existsFromSet(['/opt/real/Fooocus/launch.py']), // dir found, but no .venv
      fallbackPython: '/opt/real/Fooocus-API/.venv/bin/python3',
    });
    expect(spec.dir).toBe('/opt/real/Fooocus');
    expect(spec.python).toBe('/opt/real/Fooocus-API/.venv/bin/python3');
    expect(spec.args).toEqual(['launch.py', '--port', '7865']);
  });

  test('overrides win: explicit dir/python/port/args take precedence over discovery', () => {
    const spec = resolveFooocusSpec(
      'api',
      { dir: '/custom/foo', python: '/custom/py', port: 9999, args: ['--extra'] },
      // An explicit dir pins the search to it (the discovery candidate is ignored).
      { candidateDirs: ['/opt/real/Fooocus-API'], exists: existsFromSet(['/custom/foo/main.py']) },
    );
    expect(spec.dir).toBe('/custom/foo');
    expect(spec.python).toBe('/custom/py');
    expect(spec.port).toBe(9999);
    expect(spec.args).toEqual(['main.py', '--extra']);
  });

  test('extraArgs (memory/VRAM flags) append after base + override args, in order', () => {
    const spec = resolveFooocusSpec(
      'api',
      { args: ['--queue-size', '8'] },
      {
        candidateDirs: ['/opt/real/Fooocus-API'],
        exists: existsFromSet(['/opt/real/Fooocus-API/main.py']),
        extraArgs: ['--always-low-vram', '--all-in-fp16'],
      },
    );
    expect(spec.args).toEqual(['main.py', '--queue-size', '8', '--always-low-vram', '--all-in-fp16']);
  });

  test('ui: extraArgs append after the --port pair', () => {
    const spec = resolveFooocusSpec('ui', undefined, {
      candidateDirs: ['/opt/real/Fooocus'],
      exists: existsFromSet(['/opt/real/Fooocus/launch.py']),
      extraArgs: ['--always-low-vram'],
    });
    expect(spec.args).toEqual(['launch.py', '--port', '7865', '--always-low-vram']);
  });

  test('a bare python command override is left for PATH lookup, not absolutized', () => {
    const spec = resolveFooocusSpec(
      'api',
      { python: 'python3.11' },
      {
        candidateDirs: ['/opt/real/Fooocus-API'],
        exists: existsFromSet(['/opt/real/Fooocus-API/main.py']),
      },
    );
    expect(spec.python).toBe('python3.11'); // NOT resolved to a cwd-relative path
  });

  test('a python override that is a path is expanded', () => {
    const spec = resolveFooocusSpec(
      'api',
      { python: '/usr/bin/python3' },
      {
        candidateDirs: ['/opt/real/Fooocus-API'],
        exists: existsFromSet(['/opt/real/Fooocus-API/main.py']),
      },
    );
    expect(spec.python).toBe('/usr/bin/python3');
  });

  test('explicit dir whose entry is missing → not installed (no fallback to a discovered dir)', () => {
    const spec = resolveFooocusSpec(
      'api',
      { dir: '/typo/foo' },
      { candidateDirs: ['/opt/real/Fooocus-API'], exists: existsFromSet(['/opt/real/Fooocus-API/main.py']) },
    );
    expect(spec.dir).toBeNull();
  });
});

describe('fooocusServerView — toggle affordance', () => {
  const base: FooocusServerStatus = {
    id: 'api',
    label: 'Fooocus API',
    port: 8888,
    url: 'http://localhost:8888',
    running: false,
    managed: false,
    starting: false,
    installed: true,
    dir: '/opt/Fooocus-API',
  };

  test('stopped + installed → can start (toggle enabled, neutral)', () => {
    const v = fooocusServerView(base);
    expect(v.toggleEnabled).toBe(true);
    expect(v.tone).toBe('neutral');
    expect(v.text).toBe('Stopped');
  });

  test('running + managed → can stop (toggle enabled, success)', () => {
    const v = fooocusServerView({ ...base, running: true, managed: true });
    expect(v.toggleEnabled).toBe(true);
    expect(v.tone).toBe('success');
  });

  test('running + external → disabled, explains rubato will not stop it', () => {
    const v = fooocusServerView({ ...base, running: true, managed: false });
    expect(v.toggleEnabled).toBe(false);
    expect(v.tone).toBe('accent');
    expect(v.reason).toMatch(/outside rubato/i);
  });

  test('starting → disabled, warns it is booting', () => {
    const v = fooocusServerView({ ...base, managed: true, starting: true });
    expect(v.toggleEnabled).toBe(false);
    expect(v.tone).toBe('warn');
    expect(v.text).toBe('Starting…');
  });

  test('not installed → disabled with an error tone (deleted Fooocus degrades cleanly)', () => {
    const v = fooocusServerView({ ...base, installed: false, dir: null });
    expect(v.toggleEnabled).toBe(false);
    expect(v.tone).toBe('error');
    expect(v.text).toBe('Not installed');
  });
});
