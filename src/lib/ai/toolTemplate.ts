/**
 * Tiny `${…}` template filler for user-defined tool requests (pure). A resolver
 * supplied by the caller maps a key to its value; unknown keys become empty
 * strings. Kept dumb on purpose — secret resolution and redaction live in the
 * server-side resolver, not here, so this stays trivially testable.
 */

/** Replace `${key}` tokens via `resolve`. Unknown keys → "". */
export function fillTemplate(template: string, resolve: (key: string) => string | undefined): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, raw) => resolve(String(raw).trim()) ?? '');
}

/** Replace every occurrence of each secret with `***` (for safe display/logging). */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}
