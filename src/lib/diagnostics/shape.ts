/**
 * Pure structural-shape description + diffing for diagnostics. The point is the
 * single most common surprise when rubato runs against someone else's API: "the
 * JSON came back a different shape than we assumed." `describeShape` turns any
 * value into a compact, bounded descriptor (types + keys, not the data itself —
 * so it's safe to log even when the data isn't), and `diffShape` reports how an
 * actual value's shape departs from an expected one.
 *
 * No fs / config / process here — this file is import-clean so the `src/api/*`
 * service clients and other pure `src/lib` code can use it, and it's exported
 * through the `rubato` barrel (`src/lib.ts`).
 */

/** A bounded, value-free description of a value's structure. */
export type ShapeDescriptor =
  | { kind: 'primitive'; type: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'bigint' | 'symbol' }
  | { kind: 'array'; length: number; of: ShapeDescriptor }
  | { kind: 'object'; keys: Record<string, ShapeDescriptor> }
  | { kind: 'class'; name: string }
  | { kind: 'truncated' };

export interface DescribeOptions {
  /** Stop recursing past this depth (deeper nodes become `truncated`). Default 5. */
  maxDepth?: number;
  /** Cap object keys / array element sampling so a huge payload can't explode. Default 60. */
  maxKeys?: number;
}

const DEFAULT_DEPTH = 5;
const DEFAULT_KEYS = 60;

/** Describe the structure of `value` as a bounded, value-free descriptor. */
export function describeShape(value: unknown, opts: DescribeOptions = {}): ShapeDescriptor {
  const maxDepth = opts.maxDepth ?? DEFAULT_DEPTH;
  const maxKeys = opts.maxKeys ?? DEFAULT_KEYS;
  return describe(value, maxDepth, maxKeys, 0);
}

function describe(value: unknown, maxDepth: number, maxKeys: number, depth: number): ShapeDescriptor {
  if (value === null) return { kind: 'primitive', type: 'null' };
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined' || t === 'bigint' || t === 'symbol') {
    return { kind: 'primitive', type: t };
  }
  if (depth >= maxDepth) return { kind: 'truncated' };

  if (Array.isArray(value)) {
    // Merge a bounded sample of elements into one representative element shape, so
    // an array of similar objects reads as `array<object{…}>`, not N copies.
    const sample = value.slice(0, maxKeys).map((el) => describe(el, maxDepth, maxKeys, depth + 1));
    return { kind: 'array', length: value.length, of: mergeShapes(sample) };
  }

  // Plain object vs a class instance (Date, Map, a Response, an Error…). Only walk
  // plain objects; everything else is named so the shape stays readable + bounded.
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const keys: Record<string, ShapeDescriptor> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, maxKeys);
    for (const [k, v] of entries) keys[k] = describe(v, maxDepth, maxKeys, depth + 1);
    return { kind: 'object', keys };
  }
  return { kind: 'class', name: (value as object).constructor?.name ?? 'object' };
}

/** Collapse several element descriptors into one (used for array element shapes). */
function mergeShapes(shapes: ShapeDescriptor[]): ShapeDescriptor {
  if (shapes.length === 0) return { kind: 'primitive', type: 'undefined' };
  const [first, ...rest] = shapes;
  if (first.kind !== 'object') return first; // primitives/arrays: first wins
  // Union object keys across the sample so an optional field still shows up.
  const keys: Record<string, ShapeDescriptor> = { ...first.keys };
  for (const s of rest) {
    if (s.kind !== 'object') continue;
    for (const [k, v] of Object.entries(s.keys)) if (!(k in keys)) keys[k] = v;
  }
  return { kind: 'object', keys };
}

/** A compact one-liner for a descriptor, e.g. `object{id:number, tags:string[]}`. */
export function shapeToString(s: ShapeDescriptor): string {
  switch (s.kind) {
    case 'primitive':
      return s.type;
    case 'truncated':
      return '…';
    case 'class':
      return s.name;
    case 'array':
      return `${shapeToString(s.of)}[]`;
    case 'object': {
      const inner = Object.entries(s.keys)
        .map(([k, v]) => `${k}:${shapeToString(v)}`)
        .join(', ');
      return `object{${inner}}`;
    }
  }
}

export type ShapeDiffKind = 'missing-key' | 'extra-key' | 'type-mismatch';

/** One structural difference between an actual and an expected value. */
export interface ShapeDiff {
  /** Dotted path to the differing node, e.g. `data.items[].id`. */
  path: string;
  kind: ShapeDiffKind;
  /** Expected shape at this path (one-liner), when relevant. */
  expected?: string;
  /** Actual shape at this path (one-liner), when relevant. */
  actual?: string;
}

/**
 * List how `actual`'s shape departs from `expected`'s. Both are described first,
 * then walked together. Catches the field that vanished, the field that's now a
 * different type, and unexpected extra fields — the realistic "their JSON isn't
 * what we thought" failures.
 */
export function diffShape(actual: unknown, expected: unknown, opts?: DescribeOptions): ShapeDiff[] {
  const out: ShapeDiff[] = [];
  walkDiff(describeShape(actual, opts), describeShape(expected, opts), '', out);
  return out;
}

function walkDiff(actual: ShapeDescriptor, expected: ShapeDescriptor, path: string, out: ShapeDiff[]): void {
  const here = path || '(root)';
  if (actual.kind !== expected.kind) {
    out.push({ path: here, kind: 'type-mismatch', expected: shapeToString(expected), actual: shapeToString(actual) });
    return;
  }
  if (expected.kind === 'object' && actual.kind === 'object') {
    for (const [k, ev] of Object.entries(expected.keys)) {
      const child = path ? `${path}.${k}` : k;
      const av = actual.keys[k];
      if (av === undefined) {
        out.push({ path: child, kind: 'missing-key', expected: shapeToString(ev) });
        continue;
      }
      walkDiff(av, ev, child, out);
    }
    for (const k of Object.keys(actual.keys)) {
      if (!(k in expected.keys)) {
        out.push({ path: path ? `${path}.${k}` : k, kind: 'extra-key', actual: shapeToString(actual.keys[k]) });
      }
    }
    return;
  }
  if (expected.kind === 'array' && actual.kind === 'array') {
    walkDiff(actual.of, expected.of, `${path}[]`, out);
  }
}
