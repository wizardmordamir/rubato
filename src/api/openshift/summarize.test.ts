import { describe, expect, test } from 'bun:test';
import { mapPod, type RawPod, summarizePods } from './summarize';

const rawPod = (
  name: string,
  phase: string,
  containerStatuses?: NonNullable<RawPod['status']>['containerStatuses'],
): RawPod => ({ metadata: { name }, spec: { nodeName: 'node-1' }, status: { phase, containerStatuses } });

describe('mapPod', () => {
  test('ready when all containers are ready; sums restarts', () => {
    const p = mapPod(
      rawPod('web', 'Running', [
        { ready: true, restartCount: 1 },
        { ready: true, restartCount: 2 },
      ]),
    );
    expect(p).toMatchObject({ name: 'web', phase: 'Running', ready: true, restarts: 3 });
    expect(p.reason).toBeUndefined();
  });

  test('surfaces a waiting reason (CrashLoopBackOff)', () => {
    const p = mapPod(
      rawPod('api', 'Running', [{ ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }]),
    );
    expect(p.ready).toBe(false);
    expect(p.reason).toBe('CrashLoopBackOff');
  });

  test('a Failed pod reports a Failed/terminated reason', () => {
    expect(mapPod(rawPod('job', 'Failed', [{ ready: false, state: { terminated: { reason: 'Error' } } }])).reason).toBe(
      'Error',
    );
    expect(mapPod(rawPod('job', 'Failed')).reason).toBe('Failed');
  });

  test('a Running-but-not-ready pod (no waiting reason) → NotReady', () => {
    expect(mapPod(rawPod('web', 'Running', [{ ready: false }])).reason).toBe('NotReady');
  });
});

describe('summarizePods', () => {
  test('counts phases, notReady, restarts, and builds the problem list', () => {
    const s = summarizePods([
      rawPod('ok', 'Running', [{ ready: true, restartCount: 0 }]),
      rawPod('crash', 'Running', [
        { ready: false, restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } } },
      ]),
      rawPod('notready', 'Running', [{ ready: false, restartCount: 0 }]),
      rawPod('pending', 'Pending'),
      rawPod('done', 'Succeeded'),
      rawPod('dead', 'Failed', [{ ready: false, state: { terminated: { reason: 'OOMKilled' } } }]),
    ]);
    expect(s.total).toBe(6);
    expect(s.running).toBe(3);
    expect(s.pending).toBe(1);
    expect(s.succeeded).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.notReady).toBe(2); // crash + notready (Running & not ready)
    expect(s.restarts).toBe(9);
    expect(s.problematic.map((p) => p.reason).sort()).toEqual(['CrashLoopBackOff', 'NotReady', 'OOMKilled']);
  });

  test('empty namespace → all zeros', () => {
    const s = summarizePods([]);
    expect(s).toMatchObject({ total: 0, running: 0, failed: 0, notReady: 0, restarts: 0, problematic: [] });
  });
});
