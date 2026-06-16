/**
 * Pull a single value out of unstructured text — the reusable core of "find the
 * version / image sha in this blob and feed it to a variable" (task 42). Pure and
 * dependency-free, so a pipeline step (or any caller) can lift a value from a
 * scraped textarea / a downloaded report and pass it on as `${VAR}`.
 *
 *   // "find the app's jenkins name, then the next line starting with sha256:"
 *   extractValue(text, { kind: "afterAnchor", anchor: "my-app", startsWith: "sha256:" })
 *   // a plain regex with a capture group
 *   extractValue(text, { kind: "regex", pattern: "version: (\\d+\\.\\d+\\.\\d+)", group: 1 })
 *
 * The companion `extract-text` pipeline script wraps this for run dirs / vars.
 */

export type ExtractSpec =
  | {
      kind: 'regex';
      /** A RegExp source. Throws if it's not a valid pattern. */
      pattern: string;
      flags?: string;
      /** Capture group to return (0 = whole match, default). */
      group?: number;
    }
  | {
      kind: 'afterAnchor';
      /** Find the first line that contains this (or matches it, if `anchorIsRegex`). */
      anchor: string;
      anchorIsRegex?: boolean;
      /** Then return the first SUBSEQUENT line that starts with this prefix… */
      startsWith?: string;
      /** …or the first subsequent line matching this regex (returns `group`). */
      pattern?: string;
      flags?: string;
      group?: number;
      /** With neither startsWith nor pattern: skip blank lines when taking "the next line". */
      skipBlank?: boolean;
    }
  | {
      kind: 'lineContaining';
      /** The first line containing this substring. */
      contains: string;
      /** Optional sub-capture applied to that line (returns `group`). */
      pattern?: string;
      flags?: string;
      group?: number;
    };

const lines = (text: string): string[] => text.split(/\r?\n/);

/** Apply a regex to one string and return the requested group, or null. */
function matchGroup(s: string, pattern: string, flags: string | undefined, group = 0): string | null {
  const m = new RegExp(pattern, flags).exec(s);
  return m ? (m[group] ?? null) : null;
}

/** Extract a value from `text` per `spec`, or `null` if nothing matched. */
export function extractValue(text: string, spec: ExtractSpec): string | null {
  switch (spec.kind) {
    case 'regex':
      return matchGroup(text, spec.pattern, spec.flags, spec.group ?? 0);

    case 'afterAnchor': {
      const ls = lines(text);
      const anchorIdx = ls.findIndex((l) =>
        spec.anchorIsRegex ? new RegExp(spec.anchor).test(l) : l.includes(spec.anchor),
      );
      if (anchorIdx < 0) return null;
      const after = ls.slice(anchorIdx + 1);
      if (spec.startsWith != null) {
        const hit = after.find((l) => l.trimStart().startsWith(spec.startsWith as string));
        return hit != null ? hit.trim() : null;
      }
      if (spec.pattern != null) {
        for (const l of after) {
          const g = matchGroup(l, spec.pattern, spec.flags, spec.group ?? 0);
          if (g != null) return g;
        }
        return null;
      }
      const next = spec.skipBlank ? after.find((l) => l.trim() !== '') : after[0];
      return next != null ? next.trim() : null;
    }

    case 'lineContaining': {
      const line = lines(text).find((l) => l.includes(spec.contains));
      if (line == null) return null;
      return spec.pattern != null ? matchGroup(line, spec.pattern, spec.flags, spec.group ?? 0) : line.trim();
    }
  }
}

/** Extract several named values at once; only matches are included in the result. */
export function extractValues(text: string, specs: Record<string, ExtractSpec>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = extractValue(text, spec);
    if (value != null) out[name] = value;
  }
  return out;
}
