import { describe, expect, test } from 'bun:test';
import {
  caSmokeSpec,
  pickFreePort,
  planSmoke,
  rubatoSmokeSpec,
  runBootSmoke,
  type SmokeDeps,
  type SmokeSpec,
  smokeEnv,
  smokeHomeDir,
} from './bootSmoke';

describe('planSmoke', () => {
  test('fills defaults (healthPath, timeoutMs) and keeps explicit fields', () => {
    const spec = planSmoke({
      repo: 'x',
      cmd: ['bun', 'run', 'serve'],
      cwd: '/tmp/x-integration',
      homeEnvVar: 'X_HOME',
      portEnvVar: 'X_PORT',
      port: 5555,
      homeDir: '/tmp/x-home',
    });
    expect(spec.healthPath).toBe('/api/health');
    expect(spec.timeoutMs).toBe(30_000);
    expect(spec.port).toBe(5555);
    expect(spec.cwd).toBe('/tmp/x-integration');
  });

  test('respects an explicit healthPath + timeoutMs', () => {
    const spec = planSmoke({
      repo: 'x',
      cmd: ['bun', 'run', 'serve'],
      cwd: '/tmp',
      homeEnvVar: 'X_HOME',
      portEnvVar: 'X_PORT',
      port: 1,
      homeDir: '/tmp/h',
      healthPath: '/healthz',
      timeoutMs: 5_000,
    });
    expect(spec.healthPath).toBe('/healthz');
    expect(spec.timeoutMs).toBe(5_000);
  });
});

describe('smokeEnv', () => {
  test('isolates the home + binds the port, merging extras', () => {
    const spec = planSmoke({
      repo: 'x',
      cmd: ['bun'],
      cwd: '/tmp',
      homeEnvVar: 'RUBATO_HOME',
      portEnvVar: 'RUBATO_PORT',
      port: 4848,
      homeDir: '/tmp/throwaway',
      extraEnv: { NODE_ENV: 'test' },
    });
    expect(smokeEnv(spec)).toEqual({ RUBATO_HOME: '/tmp/throwaway', RUBATO_PORT: '4848', NODE_ENV: 'test' });
  });
});

describe('rubatoSmokeSpec', () => {
  test('boots rubato-serve isolated via RUBATO_HOME/RUBATO_PORT at /api/health, no --hot', () => {
    const spec = rubatoSmokeSpec({ cwd: '/repo/rubato-integration', port: 4848, homeDir: '/tmp/ru-home' });
    expect(spec.repo).toBe('ru');
    expect(spec.cmd).toEqual(['bun', 'run', 'src/scripts/serve.ts']);
    expect(spec.cmd).not.toContain('--hot');
    expect(spec.homeEnvVar).toBe('RUBATO_HOME');
    expect(spec.portEnvVar).toBe('RUBATO_PORT');
    expect(spec.healthPath).toBe('/api/health');
    expect(smokeEnv(spec)).toEqual({ RUBATO_HOME: '/tmp/ru-home', RUBATO_PORT: '4848' });
  });
});

describe('caSmokeSpec', () => {
  test('boots ca via CA_DATA_DIR/PORT at /api/health with the env it needs at boot', () => {
    const spec = caSmokeSpec({ cwd: '/repo/cursedalchemy-integration/server', port: 5099, homeDir: '/tmp/ca-home' });
    expect(spec.repo).toBe('ca');
    expect(spec.cmd).toEqual(['bun', 'src/index.ts']);
    expect(spec.cwd).toBe('/repo/cursedalchemy-integration/server');
    expect(spec.homeEnvVar).toBe('CA_DATA_DIR');
    expect(spec.portEnvVar).toBe('PORT');
    expect(spec.healthPath).toBe('/api/health');
    const env = smokeEnv(spec);
    // Isolation knobs.
    expect(env.CA_DATA_DIR).toBe('/tmp/ca-home');
    expect(env.PORT).toBe('5099');
    // The keys ca's server requires at boot (ensureRequiredKeysExist + jwt.ts).
    expect(env.COMPANY_NAME).toBeTruthy();
    expect(env.BASE_URL).toBe('http://127.0.0.1:5099');
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.NODE_ENV).toBe('development');
  });
});

// A stub `startTestServer` whose health behaviour we control, recording lifecycle.
function fakeStart(opts: { healthy: boolean; logs?: string[] }) {
  const calls = { started: 0, stopped: 0, lastOpts: undefined as unknown };
  const start: NonNullable<SmokeDeps['startServer']> = async (o) => {
    calls.started++;
    calls.lastOpts = o;
    if (!opts.healthy) throw new Error('server never became healthy\n<<logs>>');
    return {
      logs: () => opts.logs ?? ['listening on 127.0.0.1'],
      stop: async () => {
        calls.stopped++;
      },
    };
  };
  return { start, calls };
}

const baseSpec = (): SmokeSpec =>
  planSmoke({
    repo: 'ru',
    cmd: ['bun', 'run', 'src/scripts/serve.ts'],
    cwd: '/repo/rubato-integration',
    homeEnvVar: 'RUBATO_HOME',
    portEnvVar: 'RUBATO_PORT',
    port: 4848,
    homeDir: '/tmp/ru-smoke-home',
  });

describe('runBootSmoke (injected)', () => {
  test('healthy boot → ok, cleans up the server + home, reports duration', async () => {
    const created: string[] = [];
    const removed: string[] = [];
    const { start, calls } = fakeStart({ healthy: true, logs: ['boot', 'ready'] });
    let t = 1000;
    const res = await runBootSmoke(baseSpec(), {
      startServer: start,
      ensureDir: async (d) => {
        created.push(d);
      },
      removeDir: async (d) => {
        removed.push(d);
      },
      now: () => (t += 50),
    });
    expect(res.ok).toBe(true);
    expect(res.repo).toBe('ru');
    expect(res.detail).toContain('/api/health');
    expect(res.logTail).toContain('ready');
    expect(res.durationMs).toBeGreaterThan(0);
    expect(created).toEqual(['/tmp/ru-smoke-home']);
    expect(removed).toEqual(['/tmp/ru-smoke-home']); // home cleaned up
    expect(calls.started).toBe(1);
    expect(calls.stopped).toBe(1); // server torn down
    // The isolation env reached startTestServer.
    expect((calls.lastOpts as { env: Record<string, string> }).env.RUBATO_HOME).toBe('/tmp/ru-smoke-home');
  });

  test('never-healthy boot → ok:false with the failure surfaced, home still removed', async () => {
    const removed: string[] = [];
    const { start, calls } = fakeStart({ healthy: false });
    const res = await runBootSmoke(baseSpec(), {
      startServer: start,
      ensureDir: async () => {},
      removeDir: async (d) => {
        removed.push(d);
      },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('boot smoke failed');
    expect(res.detail).toContain('never became healthy');
    expect(removed).toEqual(['/tmp/ru-smoke-home']); // cleaned up even on failure
    expect(calls.stopped).toBe(0); // nothing to stop — start threw
  });

  test("can't create the isolated home → ok:false, server never started", async () => {
    const { start, calls } = fakeStart({ healthy: true });
    const res = await runBootSmoke(baseSpec(), {
      startServer: start,
      ensureDir: async () => {
        throw new Error('EACCES');
      },
      removeDir: async () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('failed to create isolated home');
    expect(calls.started).toBe(0);
  });
});

describe('smokeHomeDir / pickFreePort', () => {
  test('smokeHomeDir is repo+seed scoped under tmp', () => {
    const dir = smokeHomeDir('ca', 99);
    expect(dir).toContain('intgate-smoke-ca-99');
  });
  test('pickFreePort returns a usable ephemeral port', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });
});
