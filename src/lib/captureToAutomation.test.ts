import { describe, expect, test } from 'bun:test';
import type { CaptureManifest, CaptureRecord } from '../shared/capture';
import { captureToAutomation } from './captureToAutomation';

function rec(r: Partial<CaptureRecord> & { seq: number; kind: CaptureRecord['kind'] }): CaptureRecord {
  return { ts: r.seq, url: `https://x/${r.seq}`, ...r } as CaptureRecord;
}

function manifest(records: CaptureRecord[]): CaptureManifest {
  return { id: 'cap-1', label: 'deploy screens', startedAt: 0, records };
}

describe('captureToAutomation', () => {
  test("uses the start record's url as startUrl and drops start/manual", () => {
    const a = captureToAutomation(
      manifest([rec({ seq: 0, kind: 'start', url: 'https://app/login' }), rec({ seq: 1, kind: 'manual' })]),
    );
    expect(a.startUrl).toBe('https://app/login');
    expect(a.steps).toEqual([]);
  });

  test('lifts action records verbatim into steps', () => {
    const a = captureToAutomation(
      manifest([
        rec({ seq: 0, kind: 'start' }),
        rec({ seq: 1, kind: 'action', action: 'click', target: { kind: 'role', value: 'button', name: 'Save' } }),
        rec({ seq: 2, kind: 'action', action: 'fill', target: { kind: 'id', value: 'user' }, params: { value: 'me' } }),
      ]),
    );
    expect(a.steps).toEqual([
      { id: 'step-1', action: 'click', target: { kind: 'role', value: 'button', name: 'Save' } },
      { id: 'step-2', action: 'fill', target: { kind: 'id', value: 'user' }, params: { value: 'me' } },
    ]);
  });

  test("drops a navigation that follows a click (it's the click's side-effect)", () => {
    const a = captureToAutomation(
      manifest([
        rec({ seq: 0, kind: 'start' }),
        rec({ seq: 1, kind: 'action', action: 'click', target: { kind: 'role', value: 'link' } }),
        rec({ seq: 2, kind: 'navigate', url: 'https://app/next' }),
      ]),
    );
    expect(a.steps).toEqual([{ id: 'step-1', action: 'click', target: { kind: 'role', value: 'link' } }]);
  });

  test('keeps a direct navigation (not preceded by a click) as a goto', () => {
    const a = captureToAutomation(
      manifest([
        rec({ seq: 0, kind: 'start' }),
        rec({ seq: 1, kind: 'action', action: 'click', target: { kind: 'id', value: 'go' } }),
        rec({ seq: 2, kind: 'navigate', url: 'https://app/a' }),
        // user typed a new URL — preceded by a navigate, so it survives as a goto
        rec({ seq: 3, kind: 'navigate', url: 'https://app/typed' }),
      ]),
    );
    expect(a.steps).toEqual([
      { id: 'step-1', action: 'click', target: { kind: 'id', value: 'go' } },
      { id: 'step-3', action: 'goto', params: { url: 'https://app/typed' } },
    ]);
  });

  test("prefers the manifest's startUrl over recorded urls", () => {
    const a = captureToAutomation({
      ...manifest([rec({ seq: 0, kind: 'start', url: 'https://app/login' })]),
      startUrl: 'https://app/picked',
    });
    expect(a.startUrl).toBe('https://app/picked');
  });

  test('blank start: skips the about:blank start record, adopts the first real navigation', () => {
    const a = captureToAutomation(
      manifest([
        rec({ seq: 0, kind: 'start', url: 'about:blank' }),
        rec({ seq: 1, kind: 'navigate', url: 'https://app/home' }),
        rec({ seq: 2, kind: 'action', action: 'click', target: { kind: 'id', value: 'go' } }),
      ]),
    );
    expect(a.startUrl).toBe('https://app/home');
    // the first navigation (prev = start) is dropped — it's the start URL itself
    expect(a.steps).toEqual([{ id: 'step-2', action: 'click', target: { kind: 'id', value: 'go' } }]);
  });

  test('cleans no-op steps a recording leaves behind (empty fill) so the flow replays', () => {
    // Mirrors the captured cursedalchemy login: a stray empty password fill after
    // a navigation, which would otherwise fail replay on a page without that field.
    const a = captureToAutomation(
      manifest([
        rec({ seq: 0, kind: 'start', url: 'https://app/login' }),
        rec({
          seq: 1,
          kind: 'action',
          action: 'fill',
          target: { kind: 'id', value: 'email' },
          params: { value: 'me' },
        }),
        rec({
          seq: 2,
          kind: 'action',
          action: 'fill',
          target: { kind: 'id', value: 'password' },
          params: { value: '', valueMode: 'secret' },
        }),
      ]),
    );
    expect(a.steps).toEqual([
      { id: 'step-1', action: 'fill', target: { kind: 'id', value: 'email' }, params: { value: 'me' } },
    ]);
  });

  test('falls back to the label / id for the name', () => {
    expect(captureToAutomation(manifest([rec({ seq: 0, kind: 'start' })])).name).toBe('deploy screens');
    expect(captureToAutomation({ ...manifest([]), label: undefined }).name).toBe('capture cap-1');
    expect(captureToAutomation(manifest([]), '  My Flow  ').name).toBe('My Flow');
  });
});
