import { expect, test } from 'bun:test';
import { currentCorrelationId, runWithCorrelation } from './correlation';

test('currentCorrelationId is undefined outside a correlation scope', () => {
  expect(currentCorrelationId()).toBeUndefined();
});

test('the correlation id propagates through awaits inside the scope', async () => {
  const seen = await runWithCorrelation('abc123', async () => {
    await Promise.resolve();
    const nested = await (async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentCorrelationId();
    })();
    return nested;
  });
  expect(seen).toBe('abc123');
  // and it doesn't leak back out
  expect(currentCorrelationId()).toBeUndefined();
});

test('concurrent scopes stay isolated', async () => {
  const [a, b] = await Promise.all([
    runWithCorrelation('A', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentCorrelationId();
    }),
    runWithCorrelation('B', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentCorrelationId();
    }),
  ]);
  expect(a).toBe('A');
  expect(b).toBe('B');
});
