/**
 * Defensive board-row normalization (heal #304).
 *
 * A few taskq rows in the wild had a TEXT column written as a spread Buffer/typed-array
 * (`{0:65,1:68,…}` of char codes, or `{0:'a',1:'b',…}` of chars) instead of a plain
 * string — the byproduct of a write path that did `{...someBuffer}`. That object survives
 * the SQLite round-trip and lands in the `/api/taskq` board JSON. When the UI renders such
 * a field as a React child (`<p>note: {task.note}</p>`), React throws
 *   "Objects are not valid as a React child (found: object with keys {0,1,…})"
 * and, with no error boundary above the board, the WHOLE page white-screens — exactly the
 * incident the promotion-gate site smoke caught on `/taskq`.
 *
 * Coercing here, at the single API boundary the board UI consumes, guarantees the board is
 * always renderable no matter how a row was written. It's pure + unit-tested so the route
 * stays a thin caller. `null`/`undefined` pass through; a char-code/char buffer object is
 * reconstructed back to its original text rather than shown as `[object Object]`.
 */

/** The TaskRow/TaskqTaskView columns that are typed as strings and rendered as text. */
export const TASK_TEXT_FIELDS = [
  'slug',
  'title',
  'body',
  'repo',
  'model',
  'think',
  'group_key',
  'serial_group',
  'note',
  'hold_disposition',
  'resolver_ref',
  'last_error',
  'triage_state',
  'complexity',
  'created_at',
  'updated_at',
  'summary',
  'commit',
] as const;

/** Coerce a value that SHOULD be a string back to one (see module doc). */
export function asText(v: unknown): string | null | undefined {
  if (v == null || typeof v === 'string') return v as string | null | undefined;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'object') {
    const keys = Object.keys(v as object);
    // A spread Buffer/array is array-like: contiguous integer keys "0","1","2",… — that's
    // what distinguishes the corruption from a genuine object like `{a:1}`.
    const isArrayLike = keys.length > 0 && keys.every((k, i) => k === String(i));
    if (isArrayLike) {
      const values = Object.values(v as Record<string, unknown>);
      if (values.every((x) => typeof x === 'number')) {
        // Char-code buffer spread (`{0:65,…}`) → reconstruct the original text. Build it in a
        // loop (not String.fromCharCode(...values)) so a large note can't blow the call stack.
        let s = '';
        for (const c of values as number[]) s += String.fromCharCode(c);
        return s;
      }
      if (values.every((x) => typeof x === 'string' && (x as string).length <= 2)) {
        // Char buffer spread (`{0:'a',…}`) → join.
        return (values as string[]).join('');
      }
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Return `t` with every text field coerced to a string (or left null). Returns the same
 * reference untouched when nothing needed fixing (the common case), and a shallow copy
 * otherwise — never mutates the input. Generic so it preserves the caller's element type.
 */
export function coerceTaskText<T>(t: T): T {
  if (t == null || typeof t !== 'object') return t;
  const rec = t as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const k of TASK_TEXT_FIELDS) {
    const v = rec[k];
    if (v != null && typeof v !== 'string') {
      out ??= { ...rec };
      out[k] = asText(v);
    }
  }
  return (out ?? t) as T;
}
