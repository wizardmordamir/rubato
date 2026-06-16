import { afterEach, expect, test } from 'bun:test';
import { clearLogs, logsForCorrelation, pushLog, recentLogs } from './logAccumulator';

afterEach(() => clearLogs());

test('logsForCorrelation returns only that id, in order', () => {
  pushLog({ ts: '1', level: 'info', msg: 'a', correlationId: 'x' });
  pushLog({ ts: '2', level: 'warn', msg: 'b', correlationId: 'y' });
  pushLog({ ts: '3', level: 'info', msg: 'c', correlationId: 'x' });
  const x = logsForCorrelation('x');
  expect(x.map((l) => l.msg)).toEqual(['a', 'c']);
  expect(logsForCorrelation('y').map((l) => l.msg)).toEqual(['b']);
  expect(logsForCorrelation('z')).toEqual([]);
});

test('recentLogs tails the buffer', () => {
  for (let i = 0; i < 10; i++) pushLog({ ts: String(i), level: 'info', msg: `m${i}` });
  expect(recentLogs(3).map((l) => l.msg)).toEqual(['m7', 'm8', 'm9']);
});
