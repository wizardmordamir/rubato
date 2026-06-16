import { describe, expect, test } from 'bun:test';
import type { ServerEvent } from '../shared/types';
import { emit, listenerCount, subscribe } from './events';

describe('events', () => {
  test('delivers events to subscribers; unsubscribe stops delivery', () => {
    const got: ServerEvent[] = [];
    const before = listenerCount();
    const unsub = subscribe((e) => got.push(e));
    expect(listenerCount()).toBe(before + 1);

    emit({ type: 'hello' });
    emit({ type: 'run:started', command: 'jenk', args: ['myapp'] });
    expect(got.map((e) => e.type)).toEqual(['hello', 'run:started']);

    unsub();
    expect(listenerCount()).toBe(before);
    emit({ type: 'hello' });
    expect(got).toHaveLength(2); // no new delivery after unsubscribe
  });
});
