/**
 * A small, faithful-enough `.gitignore` matcher — enough to keep build output,
 * dependencies, and other ignored paths out of tooling that walks a project.
 *
 * Supported: comments (`#`), blank lines, negation (`!`), anchoring (leading or
 * mid-pattern `/`), directory-only patterns (trailing `/`), and the `*`, `?`, and
 * `**` globs. Nested `.gitignore` files are layered (deepest wins); within a file
 * the last matching pattern wins, so negations re-include as in git.
 *
 * Not modelled (out of scope): the global `core.excludesFile`, `.git/info/exclude`,
 * and re-including a file whose parent directory is excluded — git itself forbids
 * the latter, and a top-down walk that skips ignored dirs gets it for free.
 */

export interface IgnoreRule {
  /** Original line, kept for debugging. */
  source: string;
  /** Compiled matcher, tested against a path relative to the rule's base dir. */
  re: RegExp;
  /** `!`-prefixed: a match re-includes instead of ignoring. */
  negated: boolean;
  /** Trailing-slash pattern: only matches directories. */
  dirOnly: boolean;
}

/** One `.gitignore`'s rules, tagged with where (relative to the walk root) they apply. */
export interface IgnoreLayer {
  /** Dir holding this `.gitignore`, relative to the walk root (`""` at the root). */
  base: string;
  rules: IgnoreRule[];
}

const REGEX_SPECIAL = '\\^$.|+()[]{}';

/** Translate a gitignore glob (path-aware: `/`, `*`, `?`, `**`) into a regex body. */
function globToRegex(glob: string): string {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` only acts as a globstar when it spans a whole path segment.
        const prevSlash = i === 0 || glob[i - 1] === '/';
        const after = i + 2;
        const nextSlash = after === glob.length || glob[after] === '/';
        if (prevSlash && nextSlash) {
          if (after === glob.length) {
            re += '.*'; // trailing `/**` (or bare `**`): everything below
            i = after;
          } else {
            re += '(?:.*/)?'; // leading `**/` or mid `/**/`: zero or more dirs
            i = after + 1; // also consume the following slash
          }
        } else {
          re += '[^/]*'; // not a full segment: a plain `*`
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '/') {
      re += '/';
      i += 1;
    } else if (REGEX_SPECIAL.includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return re;
}

/** Compile one gitignore line into a rule, or `null` for blanks/comments. */
function compileLine(raw: string): IgnoreRule | null {
  let line = raw.replace(/\s+$/, ''); // trailing whitespace is insignificant
  if (line === '' || line.startsWith('#')) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
    line = line.slice(1); // escaped leading `#`/`!`
  }

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === '') return null;

  // A leading or mid-pattern slash anchors to the gitignore's dir; otherwise the
  // pattern matches by basename at any depth. The trailing slash above doesn't count.
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }

  const core = globToRegex(line);
  const re = new RegExp(anchored ? `^${core}(?:/.*)?$` : `^(?:.*/)?${core}(?:/.*)?$`);
  return { source: raw, re, negated, dirOnly };
}

/** Parse `.gitignore` text (or any newline-joined pattern list) into rules. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const rule = compileLine(raw);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Decide whether `relPath` (relative to the walk root, `/`-separated) is ignored.
 * Layers must be ordered weakest-first (e.g. repo conventions, then root, then
 * deeper dirs); the last matching rule across all layers wins.
 */
export function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const layer of layers) {
    const sub = layer.base === '' ? relPath : relPath.slice(layer.base.length + 1);
    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(sub)) ignored = !rule.negated;
    }
  }
  return ignored;
}
