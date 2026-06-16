// A self-contained, dependency-free cron explainer + next-run calculator. Mirrors
// the regex tool in spirit: pure, browser-safe (NO Node `cron` package), and
// best-effort/forgiving. It understands:
//   • standard 5-field crontab — minute hour day-of-month month day-of-week
//   • 6-field with a leading seconds column (auto-detected by field count)
//   • the @macros (@yearly/@annually, @monthly, @weekly, @daily/@midnight, @hourly)
//   • JAN-DEC and SUN-SAT names, ranges (a-b), lists (a,b), steps (*/n, a-b/n, a/n)
//     and `?` (treated as `*` in the day fields)
// The per-field breakdown is ALWAYS exact; the one-line summary is pragmatic and
// covers the common shapes, falling back to a generic phrasing otherwise.

export type CronFieldCount = 5 | 6;

export interface CronFieldExplain {
  /** Human field name, e.g. "Minute". */
  name: string;
  /** The raw token for this field, e.g. "*\/5". */
  raw: string;
  /** Plain-English meaning of this field. */
  desc: string;
}

export interface CronExplanation {
  ok: boolean;
  error?: string;
  /** One-line plain-English summary, e.g. "At 9:30 AM, Monday through Friday". */
  summary: string;
  /** Per-field breakdown (always exact). */
  fields: CronFieldExplain[];
  /** Whether the expression was read as 5- or 6-field. */
  fieldCount: CronFieldCount;
  /** The expression after macro expansion, normalized whitespace. */
  normalized: string;
}

export interface CronRunsResult {
  ok: boolean;
  error?: string;
  runs: Date[];
}

// ── Names ────────────────────────────────────────────────────────────────────
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3).toUpperCase()); // index 0 => month 1
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_ABBR = DOW_NAMES.map((d) => d.slice(0, 3).toUpperCase()); // index 0 => Sunday (0)

// ── Field specs ────────────────────────────────────────────────────────────────
interface FieldSpec {
  key: 'second' | 'minute' | 'hour' | 'dom' | 'month' | 'dow';
  label: string;
  /** Singular unit used in breakdown text. */
  unit: string;
  /** Plural unit used in "every N ___" step text. */
  stepUnit: string;
  min: number;
  max: number;
  /** Optional name table, indexed from `min`. */
  names?: string[];
}

const SECOND: FieldSpec = {
  key: 'second',
  label: 'Second',
  unit: 'second',
  stepUnit: 'seconds',
  min: 0,
  max: 59,
};
const MINUTE: FieldSpec = {
  key: 'minute',
  label: 'Minute',
  unit: 'minute',
  stepUnit: 'minutes',
  min: 0,
  max: 59,
};
const HOUR: FieldSpec = {
  key: 'hour',
  label: 'Hour',
  unit: 'hour',
  stepUnit: 'hours',
  min: 0,
  max: 23,
};
const DOM: FieldSpec = {
  key: 'dom',
  label: 'Day of month',
  unit: 'day-of-month',
  stepUnit: 'days',
  min: 1,
  max: 31,
};
const MONTH: FieldSpec = {
  key: 'month',
  label: 'Month',
  unit: 'month',
  stepUnit: 'months',
  min: 1,
  max: 12,
  names: MONTH_ABBR,
};
const DOW: FieldSpec = {
  key: 'dow',
  label: 'Day of week',
  unit: 'day-of-week',
  stepUnit: 'days of the week',
  min: 0,
  max: 6,
  names: DOW_ABBR,
};

const FIELDS_5 = [MINUTE, HOUR, DOM, MONTH, DOW];
const FIELDS_6 = [SECOND, MINUTE, HOUR, DOM, MONTH, DOW];

// Macros expand to a 5-field expression.
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// ── Parsing ────────────────────────────────────────────────────────────────────
type Seg =
  | { kind: 'all' }
  | { kind: 'every'; step: number }
  | { kind: 'rangeEvery'; from: number; to: number; step: number }
  | { kind: 'fromEvery'; from: number; step: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'single'; value: number };

interface ParsedField {
  star: boolean;
  values: Set<number>;
  segs: Seg[];
}

const dowHi = (spec: FieldSpec) => (spec.key === 'dow' ? 7 : spec.max);

const parseValue = (tok: string, spec: FieldSpec): number => {
  const t = tok.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (spec.names) {
    const idx = spec.names.indexOf(t.toUpperCase());
    if (idx >= 0) return spec.min + idx;
  }
  throw new Error(`"${tok}" is not valid for ${spec.label.toLowerCase()}`);
};

const checkRange = (n: number, spec: FieldSpec): void => {
  if (n < spec.min || n > dowHi(spec)) {
    throw new Error(`${n} is out of range for ${spec.label.toLowerCase()} (${spec.min}-${spec.max})`);
  }
};

const parseField = (raw: string, spec: FieldSpec): ParsedField => {
  const isDayField = spec.key === 'dom' || spec.key === 'dow';
  const values = new Set<number>();
  const segs: Seg[] = [];
  // dow: both 0 and 7 mean Sunday — store 0 so it matches Date.getDay().
  const add = (n: number) => values.add(spec.key === 'dow' && n === 7 ? 0 : n);

  for (const piece of raw.split(',')) {
    const p = piece.trim();
    if (p === '') throw new Error(`empty segment in ${spec.label.toLowerCase()}`);

    if (p === '*' || (isDayField && p === '?')) {
      segs.push({ kind: 'all' });
      for (let n = spec.min; n <= spec.max; n++) add(n);
      continue;
    }

    if (p.includes('/')) {
      const [base, stepStr] = p.split('/');
      const step = Number(stepStr);
      if (!/^\d+$/.test(stepStr) || step < 1) {
        throw new Error(`bad step "/${stepStr}" in ${spec.label.toLowerCase()}`);
      }
      if (base === '*') {
        segs.push({ kind: 'every', step });
        for (let n = spec.min; n <= spec.max; n += step) add(n);
      } else if (base.includes('-')) {
        const [a, b] = base.split('-');
        const from = parseValue(a, spec);
        const to = parseValue(b, spec);
        checkRange(from, spec);
        checkRange(to, spec);
        segs.push({ kind: 'rangeEvery', from, to, step });
        for (let n = from; n <= to; n += step) add(n);
      } else {
        const from = parseValue(base, spec);
        checkRange(from, spec);
        segs.push({ kind: 'fromEvery', from, step });
        for (let n = from; n <= dowHi(spec); n += step) add(n);
      }
      continue;
    }

    if (p.includes('-')) {
      const [a, b] = p.split('-');
      const from = parseValue(a, spec);
      const to = parseValue(b, spec);
      checkRange(from, spec);
      checkRange(to, spec);
      if (from > to) throw new Error(`range ${from}-${to} is backwards in ${spec.label.toLowerCase()}`);
      segs.push({ kind: 'range', from, to });
      for (let n = from; n <= to; n++) add(n);
      continue;
    }

    const v = parseValue(p, spec);
    checkRange(v, spec);
    segs.push({ kind: 'single', value: v });
    add(v);
  }

  return { star: segs.some((s) => s.kind === 'all'), values, segs };
};

interface ParsedExpr {
  fieldCount: CronFieldCount;
  normalized: string;
  fields: { spec: FieldSpec; parsed: ParsedField; raw: string }[];
}

const parseExpr = (input: string): ParsedExpr => {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter a cron expression');
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (expanded.startsWith('@')) throw new Error(`Unknown macro "${trimmed}"`);

  const tokens = expanded.split(/\s+/);
  if (tokens.length !== 5 && tokens.length !== 6) {
    throw new Error(`Expected 5 or 6 fields, got ${tokens.length}`);
  }
  const fieldCount: CronFieldCount = tokens.length === 6 ? 6 : 5;
  const specs = fieldCount === 6 ? FIELDS_6 : FIELDS_5;
  const fields = specs.map((spec, i) => ({
    spec,
    raw: tokens[i],
    parsed: parseField(tokens[i], spec),
  }));
  return { fieldCount, normalized: tokens.join(' '), fields };
};

// ── Description helpers ────────────────────────────────────────────────────────
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const nameOf = (n: number, spec: FieldSpec): string => {
  if (spec.key === 'month') return MONTH_NAMES[n - 1] ?? String(n);
  if (spec.key === 'dow') return DOW_NAMES[n === 7 ? 0 : n] ?? String(n);
  return String(n);
};

// A short phrase for one segment (lowercase, no trailing punctuation).
const segPhrase = (seg: Seg, spec: FieldSpec): string => {
  switch (seg.kind) {
    case 'all':
      return `every ${spec.unit}`;
    case 'every':
      return `every ${seg.step} ${spec.stepUnit}`;
    case 'rangeEvery':
      return `every ${seg.step} ${spec.stepUnit} from ${nameOf(seg.from, spec)} to ${nameOf(seg.to, spec)}`;
    case 'fromEvery':
      return `every ${seg.step} ${spec.stepUnit} from ${nameOf(seg.from, spec)} onward`;
    case 'range':
      return `${nameOf(seg.from, spec)} to ${nameOf(seg.to, spec)}`;
    case 'single':
      return nameOf(seg.value, spec);
  }
};

// The exact per-field meaning shown in the breakdown table.
const fieldDesc = (parsed: ParsedField, spec: FieldSpec): string => {
  if (parsed.star) return `Every ${spec.unit}`;
  if (parsed.segs.length === 1 && parsed.segs[0].kind === 'single') {
    const v = parsed.segs[0].value;
    if (spec.key === 'month' || spec.key === 'dow') return nameOf(v, spec);
    return `${capitalize(spec.unit)} ${v}`;
  }
  return capitalize(parsed.segs.map((s) => segPhrase(s, spec)).join(', '));
};

const fmtClock = (h: number, m: number, s?: number): string => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  const mm = String(m).padStart(2, '0');
  if (s === undefined) return `${hr}:${mm} ${ampm}`;
  return `${hr}:${mm}:${String(s).padStart(2, '0')} ${ampm}`;
};

const singleValue = (p?: ParsedField): number | null =>
  p && p.segs.length === 1 && p.segs[0].kind === 'single' ? p.segs[0].value : null;

const onlyEvery = (p?: ParsedField): number | null =>
  p && p.segs.length === 1 && p.segs[0].kind === 'every' ? p.segs[0].step : null;

// Inline phrase for a non-wildcard time field in the generic fallback, e.g.
// "every 5 minutes", "at minute 0", "at hours 9 through 17".
const inlineTime = (p: ParsedField, spec: FieldSpec): string => {
  const step = onlyEvery(p);
  if (step !== null) return `every ${step} ${spec.stepUnit}`;
  const plural = p.values.size > 1 || p.segs.some((s) => s.kind === 'range' || s.kind === 'rangeEvery');
  const list = p.segs.map((s) => segPhrase(s, spec)).join(', ');
  return `at ${plural ? spec.stepUnit : spec.unit} ${list}`;
};

const describeTime = (
  second: ParsedField | undefined,
  minute: ParsedField,
  hour: ParsedField,
  fieldCount: CronFieldCount,
): string => {
  const secAll = !second || second.star;
  const minV = singleValue(minute);
  const hourV = singleValue(hour);
  const secV = second ? singleValue(second) : 0;

  // Everything wide open.
  if (secAll && minute.star && hour.star) return fieldCount === 6 ? 'every second' : 'every minute';

  // Pure interval shapes.
  const secStep = second ? onlyEvery(second) : null;
  if (fieldCount === 6 && secStep !== null && minute.star && hour.star) return `every ${secStep} seconds`;
  const minStep = onlyEvery(minute);
  if (minStep !== null && hour.star && (secAll || secV === 0)) return `every ${minStep} minutes`;
  const hourStep = onlyEvery(hour);
  if (hourStep !== null && minV === 0 && (secAll || secV === 0)) return `every ${hourStep} hours`;

  // A specific wall-clock time.
  if (minV !== null && hourV !== null && (fieldCount === 5 || secV !== null)) {
    return `at ${fmtClock(hourV, minV, fieldCount === 6 ? (secV ?? 0) : undefined)}`;
  }

  // A specific minute past every hour.
  if (minV !== null && hour.star && (secAll || secV === 0)) return `at minute ${minV} of every hour`;

  // Generic fallback — combine the non-wildcard fields.
  const bits: string[] = [];
  if (fieldCount === 6 && !secAll && second) bits.push(inlineTime(second, SECOND));
  if (!minute.star) bits.push(inlineTime(minute, MINUTE));
  if (!hour.star) bits.push(inlineTime(hour, HOUR));
  return bits.length ? bits.join(', ') : fieldCount === 6 ? 'every second' : 'every minute';
};

const inlineDom = (dom: ParsedField): string => {
  const step = onlyEvery(dom);
  if (step !== null) return `every ${step} days`;
  const v = singleValue(dom);
  if (v !== null) return `day ${v} of the month`;
  const list = dom.segs.map((s) => segPhrase(s, DOM)).join(', ');
  return `days ${list} of the month`;
};

const inlineDow = (dow: ParsedField): string => {
  const step = onlyEvery(dow);
  if (step !== null) return `every ${step} days of the week`;
  if (dow.segs.length === 1) {
    const s = dow.segs[0];
    if (s.kind === 'single') return `only on ${nameOf(s.value, DOW)}`;
    if (s.kind === 'range') return `${nameOf(s.from, DOW)} through ${nameOf(s.to, DOW)}`;
  }
  if (dow.segs.every((s) => s.kind === 'single')) {
    const names = dow.segs.map((s) => nameOf((s as { value: number }).value, DOW));
    return `on ${joinAnd(names)}`;
  }
  return `on ${dow.segs.map((s) => segPhrase(s, DOW)).join(', ')}`;
};

const joinAnd = (parts: string[]): string => {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
};

const describeDays = (dom: ParsedField, dow: ParsedField): string => {
  if (dom.star && dow.star) return '';
  // A day-of-month *step* reads better without the "on" preposition.
  if (!dom.star && dow.star) return onlyEvery(dom) !== null ? inlineDom(dom) : `on ${inlineDom(dom)}`;
  if (dom.star && !dow.star) return inlineDow(dow);
  // Both restricted — cron uses OR semantics here.
  return `on ${inlineDom(dom)} or ${inlineDow(dow)}`;
};

const describeMonths = (month: ParsedField): string => {
  if (month.star) return '';
  const step = onlyEvery(month);
  if (step !== null) return `every ${step} months`;
  if (month.segs.length === 1) {
    const s = month.segs[0];
    if (s.kind === 'single') return `in ${nameOf(s.value, MONTH)}`;
    if (s.kind === 'range') return `from ${nameOf(s.from, MONTH)} through ${nameOf(s.to, MONTH)}`;
  }
  if (month.segs.every((s) => s.kind === 'single')) {
    return `in ${joinAnd(month.segs.map((s) => nameOf((s as { value: number }).value, MONTH)))}`;
  }
  return `in ${month.segs.map((s) => segPhrase(s, MONTH)).join(', ')}`;
};

const buildSummary = (p: ParsedExpr): string => {
  const get = (key: FieldSpec['key']) => p.fields.find((f) => f.spec.key === key)?.parsed;
  const second = get('second');
  const minute = get('minute')!;
  const hour = get('hour')!;
  const dom = get('dom')!;
  const month = get('month')!;
  const dow = get('dow')!;

  const out = [describeTime(second, minute, hour, p.fieldCount), describeDays(dom, dow), describeMonths(month)]
    .filter(Boolean)
    .join(', ');
  return capitalize(out) || 'Every minute';
};

// ── Public API ─────────────────────────────────────────────────────────────────
export const explainCron = (input: string): CronExplanation => {
  let parsed: ParsedExpr;
  try {
    parsed = parseExpr(input);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not parse expression',
      summary: '',
      fields: [],
      fieldCount: (input.trim().split(/\s+/).length === 6 ? 6 : 5) as CronFieldCount,
      normalized: input.trim(),
    };
  }
  return {
    ok: true,
    summary: buildSummary(parsed),
    fields: parsed.fields.map((f) => ({
      name: f.spec.label,
      raw: f.raw,
      desc: fieldDesc(f.parsed, f.spec),
    })),
    fieldCount: parsed.fieldCount,
    normalized: parsed.normalized,
  };
};

const dayMatches = (date: Date, dom: ParsedField, dow: ParsedField): boolean => {
  const domR = !dom.star;
  const dowR = !dow.star;
  const domOk = dom.values.has(date.getDate());
  const dowOk = dow.values.has(date.getDay());
  if (domR && dowR) return domOk || dowOk;
  if (domR) return domOk;
  if (dowR) return dowOk;
  return true;
};

// Compute the next `count` fire times after `from` (default now). Browser-safe:
// steps minute-by-minute and enumerates matching seconds within a minute, so even
// 6-field expressions stay fast.
export const nextCronRuns = (input: string, count = 5, from: Date = new Date()): CronRunsResult => {
  let parsed: ParsedExpr;
  try {
    parsed = parseExpr(input);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid expression',
      runs: [],
    };
  }
  const get = (key: FieldSpec['key']) => parsed.fields.find((f) => f.spec.key === key)?.parsed;
  const second = get('second');
  const minute = get('minute')!;
  const hour = get('hour')!;
  const dom = get('dom')!;
  const month = get('month')!;
  const dow = get('dow')!;

  const seconds = parsed.fieldCount === 6 && second ? [...second.values].sort((a, b) => a - b) : [0];
  const runs: Date[] = [];
  const fromTime = from.getTime();
  // Start at the top of `from`'s minute, then walk forward.
  let t = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes(), 0, 0);
  const MAX_MINUTES = 366 * 24 * 60 * 5; // ~5 years — guards against impossible patterns

  for (let i = 0; i < MAX_MINUTES && runs.length < count; i++) {
    const minuteOk =
      minute.values.has(t.getMinutes()) &&
      hour.values.has(t.getHours()) &&
      month.values.has(t.getMonth() + 1) &&
      dayMatches(t, dom, dow);
    if (minuteOk) {
      for (const sec of seconds) {
        const cand = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes(), sec, 0);
        if (cand.getTime() > fromTime) {
          runs.push(cand);
          if (runs.length >= count) break;
        }
      }
    }
    t = new Date(t.getTime() + 60_000);
  }
  return { ok: true, runs };
};

// ── Reference data for the builder UI ──────────────────────────────────────────
export interface CronPreset {
  label: string;
  expr: string;
  description: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every minute', expr: '* * * * *', description: 'Runs at the start of every minute' },
  {
    label: 'Every 5 minutes',
    expr: '*/5 * * * *',
    description: 'Every 5 minutes, on the 0th second',
  },
  { label: 'Every 15 minutes', expr: '*/15 * * * *', description: 'Quarter-hourly' },
  { label: 'Every hour', expr: '0 * * * *', description: 'At minute 0 of every hour' },
  { label: 'Every day at midnight', expr: '0 0 * * *', description: 'Once a day at 12:00 AM' },
  { label: 'Every day at 9 AM', expr: '0 9 * * *', description: 'Once a day at 9:00 AM' },
  { label: 'Weekdays at 9 AM', expr: '0 9 * * 1-5', description: 'Mon–Fri at 9:00 AM' },
  { label: 'Weekends at 10 AM', expr: '0 10 * * 0,6', description: 'Sat & Sun at 10:00 AM' },
  { label: '1st of month, midnight', expr: '0 0 1 * *', description: 'First day of each month' },
  { label: 'Every Sunday 2 AM', expr: '0 2 * * 0', description: 'Weekly, Sunday at 2:00 AM' },
  { label: 'Every quarter', expr: '0 0 1 1,4,7,10 *', description: 'First of Jan/Apr/Jul/Oct' },
  { label: 'Every 30 seconds', expr: '*/30 * * * * *', description: '6-field, twice a minute' },
];

export interface CronFieldDef {
  key: string;
  label: string;
  help: string;
  presets: { label: string; value: string }[];
}

// Field-by-field builder metadata, in expression order. With/without the leading
// seconds column.
export const cronFieldDefs = (withSeconds: boolean): CronFieldDef[] => {
  const defs: CronFieldDef[] = [
    {
      key: 'second',
      label: 'Second',
      help: '0–59',
      presets: [
        { label: 'every', value: '*' },
        { label: '0', value: '0' },
        { label: '*/15', value: '*/15' },
        { label: '*/30', value: '*/30' },
      ],
    },
    {
      key: 'minute',
      label: 'Minute',
      help: '0–59',
      presets: [
        { label: 'every', value: '*' },
        { label: '0', value: '0' },
        { label: '*/5', value: '*/5' },
        { label: '*/15', value: '*/15' },
        { label: '*/30', value: '*/30' },
      ],
    },
    {
      key: 'hour',
      label: 'Hour',
      help: '0–23',
      presets: [
        { label: 'every', value: '*' },
        { label: '0', value: '0' },
        { label: '9', value: '9' },
        { label: '9-17', value: '9-17' },
        { label: '*/2', value: '*/2' },
      ],
    },
    {
      key: 'dom',
      label: 'Day of month',
      help: '1–31',
      presets: [
        { label: 'every', value: '*' },
        { label: '1', value: '1' },
        { label: '15', value: '15' },
        { label: '*/2', value: '*/2' },
      ],
    },
    {
      key: 'month',
      label: 'Month',
      help: '1–12 or JAN–DEC',
      presets: [
        { label: 'every', value: '*' },
        { label: 'JAN', value: '1' },
        { label: 'quarter', value: '1,4,7,10' },
        { label: '*/3', value: '*/3' },
      ],
    },
    {
      key: 'dow',
      label: 'Day of week',
      help: '0–6 (Sun=0) or SUN–SAT',
      presets: [
        { label: 'every', value: '*' },
        { label: 'weekdays', value: '1-5' },
        { label: 'weekends', value: '0,6' },
        { label: 'MON', value: '1' },
      ],
    },
  ];
  return withSeconds ? defs : defs.filter((d) => d.key !== 'second');
};
