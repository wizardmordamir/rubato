import { inferRowShape, inferShape, type ShapeToTsOptions, shapeToInterface } from 'cwip/shape';

// "Auto-make TypeScript types from live data" — the seam behind the result views'
// **TS** tab. Given a query/table result (array of row objects) or any single
// JSON value, infer its structural shape (cwip/shape) and emit a named TS
// declaration: an `interface` for object/row data, a `type` alias otherwise.
// Pure + browser-safe, so the UI imports it via `@shared` and `bun test` (rooted
// at `src/`) still covers it.

/** Turn an arbitrary base label (a table name, a filename) into a valid PascalCase
 *  TS type identifier. `user_accounts` → `UserAccounts`, `` → fallback. */
export function toTypeName(raw: string | undefined, fallback = 'Result'): string {
  const parts = (raw ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  // A TS identifier can't start with a digit.
  const ident = /^[0-9]/.test(pascal) ? `T${pascal}` : pascal;
  return ident || fallback;
}

/**
 * Emit a TypeScript declaration describing `data`.
 * - An array → the unified **row** type (keys present in only some rows become
 *   optional), named `typeName`.
 * - Any other value → a declaration for that value's shape.
 * An empty array can't be inferred from, so a placeholder is returned instead.
 */
export function dataToTypeScript(data: unknown, typeName = 'Result', opts: ShapeToTsOptions = {}): string {
  const name = toTypeName(typeName);
  if (Array.isArray(data)) {
    if (data.length === 0)
      return `// No rows to infer from — run a query that returns data.\nexport type ${name} = unknown;\n`;
    return shapeToInterface(name, inferRowShape(data), opts);
  }
  if (data === null || data === undefined) return `// No data to infer from.\nexport type ${name} = unknown;\n`;
  return shapeToInterface(name, inferShape(data), opts);
}
