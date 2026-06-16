import { describe, expect, it } from 'bun:test';
import { CRON_PRESETS, cronFieldDefs, explainCron, nextCronRuns } from './cron';

describe('explainCron — summaries', () => {
  const cases: [string, string][] = [
    ['* * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'At minute 0 of every hour'],
    ['0 0 * * *', 'At 12:00 AM'],
    ['0 9 * * *', 'At 9:00 AM'],
    ['30 9 * * 1-5', 'At 9:30 AM, Monday through Friday'],
    ['0 10 * * 0,6', 'At 10:00 AM, on Sunday and Saturday'],
    ['0 0 1 * *', 'At 12:00 AM, on day 1 of the month'],
    ['0 2 * * 0', 'At 2:00 AM, only on Sunday'],
    ['0 0 1 1 *', 'At 12:00 AM, on day 1 of the month, in January'],
    ['0 12 * * 1', 'At 12:00 PM, only on Monday'],
    ['0 0 1 1,4,7,10 *', 'At 12:00 AM, on day 1 of the month, in January, April, July and October'],
    ['0 */2 * * *', 'Every 2 hours'],
    ['0 0 */2 * *', 'At 12:00 AM, every 2 days'],
    ['*/30 * * * * *', 'Every 30 seconds'],
    ['0 0 9 * * 1-5', 'At 9:00:00 AM, Monday through Friday'],
  ];
  for (const [expr, summary] of cases) {
    it(`${expr} → ${summary}`, () => {
      const r = explainCron(expr);
      expect(r.ok).toBe(true);
      expect(r.summary).toBe(summary);
    });
  }
});

describe('explainCron — macros & names', () => {
  it('expands @daily', () => {
    const r = explainCron('@daily');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('0 0 * * *');
    expect(r.summary).toBe('At 12:00 AM');
  });
  it('expands @hourly', () => {
    expect(explainCron('@hourly').normalized).toBe('0 * * * *');
  });
  it('accepts month + day names', () => {
    const r = explainCron('0 0 * JAN-MAR MON');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Monday');
    expect(r.summary).toContain('January through March');
  });
  it('treats ? as wildcard in day fields', () => {
    expect(explainCron('0 0 ? * MON').ok).toBe(true);
  });
});

describe('explainCron — field breakdown & detection', () => {
  it('5-field breakdown', () => {
    const r = explainCron('30 9 * * 1-5');
    expect(r.fieldCount).toBe(5);
    expect(r.fields.map((f) => f.name)).toEqual(['Minute', 'Hour', 'Day of month', 'Month', 'Day of week']);
    expect(r.fields[0].desc).toBe('Minute 30');
    expect(r.fields[4].desc).toBe('Monday to Friday');
  });
  it('6-field detection adds Second', () => {
    const r = explainCron('0 30 9 * * *');
    expect(r.fieldCount).toBe(6);
    expect(r.fields[0].name).toBe('Second');
  });
});

describe('explainCron — errors', () => {
  it('rejects too few fields', () => {
    const r = explainCron('* * *');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('5 or 6');
  });
  it('rejects out-of-range', () => {
    expect(explainCron('99 * * * *').ok).toBe(false);
  });
  it('rejects empty', () => {
    expect(explainCron('').ok).toBe(false);
  });
  it('rejects backwards range', () => {
    expect(explainCron('0 17-9 * * *').ok).toBe(false);
  });
});

describe('nextCronRuns', () => {
  it('every minute → consecutive minutes', () => {
    const from = new Date(2026, 0, 1, 10, 30, 15);
    const { ok, runs } = nextCronRuns('* * * * *', 3, from);
    expect(ok).toBe(true);
    expect(runs.length).toBe(3);
    expect(runs[0].getMinutes()).toBe(31);
    expect(runs[0].getSeconds()).toBe(0);
    expect(runs[1].getMinutes()).toBe(32);
  });
  it('daily at 9am finds next 9am', () => {
    const from = new Date(2026, 0, 1, 10, 0, 0);
    const { runs } = nextCronRuns('0 9 * * *', 2, from);
    expect(runs[0].getDate()).toBe(2);
    expect(runs[0].getHours()).toBe(9);
    expect(runs[1].getDate()).toBe(3);
  });
  it('weekday rule skips the weekend', () => {
    // Jan 2 2026 is a Friday; next weekday 9am run is Monday Jan 5.
    const from = new Date(2026, 0, 2, 10, 0, 0);
    const { runs } = nextCronRuns('0 9 * * 1-5', 1, from);
    expect(runs[0].getDay()).toBe(1);
    expect(runs[0].getDate()).toBe(5);
  });
  it('6-field enumerates seconds', () => {
    const from = new Date(2026, 0, 1, 10, 30, 0);
    const { runs } = nextCronRuns('*/30 * * * * *', 3, from);
    expect(runs[0].getSeconds()).toBe(30);
    expect(runs[1].getMinutes()).toBe(31);
    expect(runs[1].getSeconds()).toBe(0);
  });
  it('invalid expression → not ok', () => {
    expect(nextCronRuns('nope', 1).ok).toBe(false);
  });
});

describe('reference data', () => {
  it('every preset parses & explains', () => {
    for (const p of CRON_PRESETS) {
      expect(explainCron(p.expr).ok).toBe(true);
    }
  });
  it('field defs respect the seconds toggle', () => {
    expect(cronFieldDefs(false)).toHaveLength(5);
    expect(cronFieldDefs(true)).toHaveLength(6);
    expect(cronFieldDefs(true)[0].key).toBe('second');
  });
});
