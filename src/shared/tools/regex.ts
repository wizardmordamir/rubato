/**
 * A self-contained, pure JS/TS regex explainer and live tester. The explainer
 * parses a pattern by recursive descent into a tree of human-readable nodes (no
 * external dependency); it is best-effort and intentionally forgiving — anything
 * it can't classify falls back to a literal. The tester runs the pattern against
 * an input via the JS RegExp engine and returns every match with its index. Also
 * exports the static reference data a UI needs: the flag list, the click-to-insert
 * building-block palette, and a handful of ready-made recipes. Browser-safe: no
 * React, no DOM, no Node APIs.
 */

export interface ExplainNode {
  raw: string;
  desc: string;
  children?: ExplainNode[];
  // Internal marker so adjacent single-character literals can be merged for
  // readability ("Literal text «abc»" instead of three separate rows).
  lit?: boolean;
}

export interface ExplainResult {
  ok: boolean;
  error?: string;
  nodes: ExplainNode[];
}

const ESCAPE_CLASS: Record<string, string> = {
  d: 'a digit (0-9)',
  D: 'a non-digit',
  w: 'a word character (a-z, A-Z, 0-9, _)',
  W: 'a non-word character',
  s: 'a whitespace character',
  S: 'a non-whitespace character',
};

const ESCAPE_ANCHOR: Record<string, string> = {
  b: 'Word boundary',
  B: 'Non-word boundary',
};

const ESCAPE_WHITESPACE: Record<string, string> = {
  n: 'a newline (\\n)',
  t: 'a tab (\\t)',
  r: 'a carriage return (\\r)',
  f: 'a form feed (\\f)',
  v: 'a vertical tab (\\v)',
  '0': 'a null character (\\0)',
};

const quantifierDesc = (q: string): string => {
  const lazy = q.endsWith('?') && q !== '?';
  const lazyNote = lazy ? ' (lazy — as few as possible)' : ' (greedy — as many as possible)';
  const base = lazy ? q.slice(0, -1) : q;
  switch (base) {
    case '*':
      return `Zero or more times${lazyNote}`;
    case '+':
      return `One or more times${lazyNote}`;
    case '?':
      return lazy ? 'Optional — zero or one time (lazy)' : 'Optional — zero or one time (greedy)';
    default: {
      // {n}, {n,}, {n,m}
      const inner = base.slice(1, -1);
      if (!inner.includes(',')) return `Exactly ${inner} times`;
      const [min, max] = inner.split(',');
      if (max === '' || max === undefined) return `${min} or more times${lazyNote}`;
      return `Between ${min} and ${max} times${lazyNote}`;
    }
  }
};

// Describe a single item inside a [...] character class.
const describeClassItem = (item: string): string => {
  if (item.length === 3 && item[1] === '-') return `${item[0]} to ${item[2]}`;
  if (item.startsWith('\\')) {
    const c = item[1];
    if (ESCAPE_CLASS[c]) return ESCAPE_CLASS[c];
    if (ESCAPE_WHITESPACE[c]) return ESCAPE_WHITESPACE[c];
    return `the character "${c}"`;
  }
  return `"${item}"`;
};

class Parser {
  private pos = 0;
  private group = 0;

  constructor(private readonly src: string) {}

  parse(): ExplainNode[] {
    const nodes = this.parseAlternation();
    if (this.pos < this.src.length) {
      // Unbalanced ')' or leftover — surface as a literal so we don't lose it.
      nodes.push({ raw: this.src.slice(this.pos), desc: 'Unparsed remainder', children: [] });
      this.pos = this.src.length;
    }
    return nodes;
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  private parseAlternation(): ExplainNode[] {
    const branches: ExplainNode[][] = [this.parseSequence()];
    while (this.peek() === '|') {
      this.pos++; // consume '|'
      branches.push(this.parseSequence());
    }
    if (branches.length === 1) return branches[0];
    return [
      {
        raw: '|',
        desc: 'Match one of these alternatives',
        children: branches.map((b, i) => ({
          raw: b.map((n) => n.raw).join(''),
          desc: `Option ${i + 1}`,
          children: b,
        })),
      },
    ];
  }

  private parseSequence(): ExplainNode[] {
    const out: ExplainNode[] = [];
    while (this.pos < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.parseAtom();
      if (!atom) break;
      const quant = this.readQuantifier();
      if (quant) {
        out.push({ raw: atom.raw + quant, desc: quantifierDesc(quant), children: [atom] });
      } else {
        out.push(atom);
      }
    }
    return this.mergeLiterals(out);
  }

  // Fold runs of un-quantified single-char literals into one row.
  private mergeLiterals(nodes: ExplainNode[]): ExplainNode[] {
    const out: ExplainNode[] = [];
    for (const node of nodes) {
      const prev = out[out.length - 1];
      if (node.lit && prev?.lit) {
        prev.raw += node.raw;
        prev.desc = `Literal text "${prev.raw}"`;
      } else {
        out.push({ ...node });
      }
    }
    return out;
  }

  private readQuantifier(): string {
    const start = this.pos;
    const c = this.peek();
    if (c === '*' || c === '+' || c === '?') {
      this.pos++;
    } else if (c === '{') {
      const close = this.src.indexOf('}', this.pos);
      const inner = close === -1 ? '' : this.src.slice(this.pos + 1, close);
      if (close !== -1 && /^\d+(,\d*)?$/.test(inner)) {
        this.pos = close + 1;
      } else {
        return ''; // a lone '{' is a literal brace, not a quantifier
      }
    } else {
      return '';
    }
    if (this.peek() === '?') this.pos++; // lazy
    return this.src.slice(start, this.pos);
  }

  private parseAtom(): ExplainNode | null {
    const c = this.peek();
    if (c === '(') return this.parseGroup();
    if (c === '[') return this.parseCharClass();
    if (c === '\\') return this.parseEscape();
    if (c === '.') {
      this.pos++;
      return { raw: '.', desc: 'Any character (except newline, unless the s flag is set)' };
    }
    if (c === '^') {
      this.pos++;
      return { raw: '^', desc: 'Start of string (or line, with the m flag)' };
    }
    if (c === '$') {
      this.pos++;
      return { raw: '$', desc: 'End of string (or line, with the m flag)' };
    }
    // Literal character.
    this.pos++;
    return { raw: c, desc: `Literal text "${c}"`, lit: true };
  }

  private parseGroup(): ExplainNode {
    const start = this.pos;
    this.pos++; // consume '('
    let desc = '';
    if (this.peek() === '?') {
      const k = this.peek(1);
      if (k === ':') {
        this.pos += 2;
        desc = 'Non-capturing group';
      } else if (k === '=') {
        this.pos += 2;
        desc = 'Positive lookahead — followed by';
      } else if (k === '!') {
        this.pos += 2;
        desc = 'Negative lookahead — not followed by';
      } else if (k === '<' && this.peek(2) === '=') {
        this.pos += 3;
        desc = 'Positive lookbehind — preceded by';
      } else if (k === '<' && this.peek(2) === '!') {
        this.pos += 3;
        desc = 'Negative lookbehind — not preceded by';
      } else if (k === '<') {
        const close = this.src.indexOf('>', this.pos);
        const name = close === -1 ? '' : this.src.slice(this.pos + 2, close);
        this.pos = close === -1 ? this.pos + 2 : close + 1;
        this.group++;
        desc = `Named capture group «${name}»`;
      } else {
        this.pos++; // unknown (?...) — skip the '?'
        desc = 'Group';
      }
    } else {
      this.group++;
      desc = `Capture group ${this.group}`;
    }
    const children = this.parseAlternation();
    if (this.peek() === ')') this.pos++; // consume ')'
    return { raw: this.src.slice(start, this.pos), desc, children };
  }

  private parseCharClass(): ExplainNode {
    const start = this.pos;
    this.pos++; // consume '['
    const negated = this.peek() === '^';
    if (negated) this.pos++;
    const items: string[] = [];
    while (this.pos < this.src.length && this.peek() !== ']') {
      if (this.peek() === '\\') {
        items.push(this.src.slice(this.pos, this.pos + 2));
        this.pos += 2;
      } else if (this.peek(1) === '-' && this.peek(2) !== ']' && this.peek(2) !== '') {
        items.push(this.src.slice(this.pos, this.pos + 3));
        this.pos += 3;
      } else {
        items.push(this.peek());
        this.pos++;
      }
    }
    if (this.peek() === ']') this.pos++; // consume ']'
    const list = items.map(describeClassItem).join(', ');
    const desc = negated ? `Any character except: ${list}` : `Any one of: ${list}`;
    return { raw: this.src.slice(start, this.pos), desc };
  }

  private parseEscape(): ExplainNode {
    const start = this.pos;
    this.pos++; // consume '\'
    const c = this.peek();
    this.pos++;
    if (ESCAPE_CLASS[c]) return { raw: this.src.slice(start, this.pos), desc: `Match ${ESCAPE_CLASS[c]}` };
    if (ESCAPE_ANCHOR[c]) return { raw: this.src.slice(start, this.pos), desc: ESCAPE_ANCHOR[c] };
    if (ESCAPE_WHITESPACE[c]) return { raw: this.src.slice(start, this.pos), desc: `Match ${ESCAPE_WHITESPACE[c]}` };
    if (c === 'x') {
      this.pos += 2; // two hex digits
      return {
        raw: this.src.slice(start, this.pos),
        desc: `Hex character ${this.src.slice(start, this.pos)}`,
      };
    }
    if (c === 'u') {
      if (this.peek() === '{') {
        const close = this.src.indexOf('}', this.pos);
        this.pos = close === -1 ? this.pos : close + 1;
      } else {
        this.pos += 4; // four hex digits
      }
      return {
        raw: this.src.slice(start, this.pos),
        desc: `Unicode character ${this.src.slice(start, this.pos)}`,
      };
    }
    if ((c === 'p' || c === 'P') && this.peek() === '{') {
      const close = this.src.indexOf('}', this.pos);
      this.pos = close === -1 ? this.pos : close + 1;
      const negated = c === 'P';
      return {
        raw: this.src.slice(start, this.pos),
        desc: `Unicode property ${this.src.slice(start, this.pos)}${negated ? ' (negated)' : ''} (needs the u flag)`,
      };
    }
    if (c === 'k' && this.peek() === '<') {
      const close = this.src.indexOf('>', this.pos);
      const name = close === -1 ? '' : this.src.slice(this.pos + 1, close);
      this.pos = close === -1 ? this.pos : close + 1;
      return {
        raw: this.src.slice(start, this.pos),
        desc: `Back-reference to named group «${name}»`,
      };
    }
    if (/[1-9]/.test(c)) {
      return { raw: this.src.slice(start, this.pos), desc: `Back-reference to capture group ${c}` };
    }
    // Escaped literal (e.g. \. \( \\).
    return { raw: this.src.slice(start, this.pos), desc: `Literal "${c}"`, lit: true };
  }
}

export const explainRegex = (pattern: string): ExplainResult => {
  if (!pattern) return { ok: true, nodes: [] };
  try {
    const nodes = new Parser(pattern).parse();
    return { ok: true, nodes };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not parse pattern',
      nodes: [],
    };
  }
};

export interface MatchInfo {
  match: string;
  index: number;
  groups: { name: string; value: string | undefined }[];
}

export interface TestResult {
  ok: boolean;
  error?: string;
  matches: MatchInfo[];
}

// Run the pattern against a test string. Always uses a cloned regex with the
// global flag so we can collect every match without mutating caller state.
export const testRegex = (pattern: string, flags: string, input: string): TestResult => {
  if (!pattern) return { ok: true, matches: [] };
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid pattern',
      matches: [],
    };
  }
  const matches: MatchInfo[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic exec loop
  while ((m = re.exec(input)) !== null) {
    matches.push({
      match: m[0],
      index: m.index,
      groups: m.slice(1).map((value, i) => ({ name: `$${i + 1}`, value })),
    });
    if (m[0] === '') re.lastIndex++; // avoid infinite loop on empty matches
    if (++guard > 10000) break; // hard safety cap
  }
  return { ok: true, matches };
};

// ── Static reference data for the Regex tool UI ──────────────────────────────
// Flags, insertable building blocks, and a handful of ready-made recipes. All
// client-side. (Persisting saved patterns is handled by the server — see the
// SavedRegex wire type in src/shared/types.ts.)

export interface RegexFlag {
  flag: string;
  label: string;
  description: string;
}

export const REGEX_FLAGS: RegexFlag[] = [
  { flag: 'g', label: 'global', description: 'Find all matches, not just the first' },
  { flag: 'i', label: 'ignore case', description: 'Case-insensitive matching' },
  { flag: 'm', label: 'multiline', description: '^ and $ match at line breaks' },
  { flag: 's', label: 'dotall', description: '. also matches newlines' },
  { flag: 'u', label: 'unicode', description: 'Treat the pattern as a sequence of code points' },
  { flag: 'y', label: 'sticky', description: 'Match only from lastIndex' },
];

export interface RegexBlock {
  label: string;
  insert: string;
  hint: string;
}

export interface RegexBlockGroup {
  group: string;
  blocks: RegexBlock[];
}

// Click-to-insert palette — the "choose what to do, it builds the regex" half.
export const REGEX_BLOCKS: RegexBlockGroup[] = [
  {
    group: 'Characters',
    blocks: [
      { label: 'Digit', insert: '\\d', hint: 'Any digit 0-9' },
      { label: 'Word char', insert: '\\w', hint: 'Letter, digit, or underscore' },
      { label: 'Whitespace', insert: '\\s', hint: 'Space, tab, newline' },
      { label: 'Any char', insert: '.', hint: 'Any character except newline' },
      { label: 'Letter a-z', insert: '[a-z]', hint: 'A lowercase letter' },
      { label: 'Set [...]', insert: '[]', hint: 'Any one of the listed characters' },
    ],
  },
  {
    group: 'Quantifiers',
    blocks: [
      { label: 'One or more', insert: '+', hint: 'Previous item, 1+ times' },
      { label: 'Zero or more', insert: '*', hint: 'Previous item, 0+ times' },
      { label: 'Optional', insert: '?', hint: 'Previous item, 0 or 1 time' },
      { label: 'Exactly {n}', insert: '{3}', hint: 'Previous item, exactly n times' },
      { label: 'Range {n,m}', insert: '{2,4}', hint: 'Previous item, n to m times' },
    ],
  },
  {
    group: 'Anchors & groups',
    blocks: [
      { label: 'Start ^', insert: '^', hint: 'Start of string/line' },
      { label: 'End $', insert: '$', hint: 'End of string/line' },
      { label: 'Word boundary', insert: '\\b', hint: 'Edge of a word' },
      { label: 'Group ()', insert: '()', hint: 'Capture group' },
      { label: 'Or |', insert: '|', hint: 'Match either side' },
    ],
  },
];

export interface RegexRecipe {
  label: string;
  pattern: string;
  flags: string;
  description: string;
}

export const REGEX_RECIPES: RegexRecipe[] = [
  {
    label: 'Email',
    pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+',
    flags: 'g',
    description: 'A simple email address',
  },
  {
    label: 'URL',
    pattern: 'https?:\\/\\/[\\w.-]+(?:\\/[\\w./?%&=-]*)?',
    flags: 'g',
    description: 'An http(s) URL',
  },
  {
    label: 'Digits only',
    pattern: '^\\d+$',
    flags: '',
    description: 'A string of only digits',
  },
  {
    label: 'Hex color',
    pattern: '#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b',
    flags: 'g',
    description: 'A #RGB or #RRGGBB color',
  },
  {
    label: 'ISO date',
    pattern: '\\d{4}-\\d{2}-\\d{2}',
    flags: 'g',
    description: 'A YYYY-MM-DD date',
  },
  {
    label: 'IPv4',
    pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
    flags: 'g',
    description: 'A dotted IPv4 address',
  },
];
