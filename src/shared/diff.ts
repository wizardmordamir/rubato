/**
 * Pure unified-diff parser (browser-safe, dependency-free) — turns the text output
 * of `git diff` into a structured model the UI renders GitHub-style: files → hunks
 * → lines, each content line carrying its old and/or new line number. Used by the
 * `<DiffViewer>` (apps-template review + per-file app diffs). Pure, so it's
 * unit-tested without a repo.
 */

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  /** Line content with the leading +/-/space marker stripped. */
  text: string;
  /** 1-based line number in the old file (present on context + deletions). */
  oldNo?: number;
  /** 1-based line number in the new file (present on context + additions). */
  newNo?: number;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ …` header line. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFileChange {
  /** Path shown in the file header (new path, falling back to the old path). */
  path: string;
  oldPath?: string;
  newPath?: string;
  /** `added`/`deleted` when one side is /dev/null; otherwise `modified`. */
  kind: 'modified' | 'added' | 'deleted';
  hunks: DiffHunk[];
  /** Totals across all hunks, for the file-header summary. */
  additions: number;
  deletions: number;
  /** Git reported a binary file (no textual hunks to show). */
  binary: boolean;
}

/** `@@ -oldStart[,oldLines] +newStart[,newLines] @@` — capture the two start lines. */
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Strip git's `a/` or `b/` path prefix; `/dev/null` → '' (a created/deleted side). */
const stripPrefix = (p: string): string => (p === '/dev/null' ? '' : p.replace(/^[ab]\//, ''));

export function parseUnifiedDiff(diff: string): DiffFileChange[] {
  if (!diff.trim()) return [];

  const files: DiffFileChange[] = [];
  let file: DiffFileChange | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const startFile = (): DiffFileChange => {
    const f: DiffFileChange = { path: '', kind: 'modified', hunks: [], additions: 0, deletions: 0, binary: false };
    files.push(f);
    hunk = null;
    return f;
  };

  // A trailing newline yields a spurious final '' element — drop just that one
  // (a genuine blank context line is a single space, never '').
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git')) {
      file = startFile();
      continue;
    }
    if (!file) file = startFile(); // tolerate diffs that don't open with `diff --git`

    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4).trim());
      file.oldPath = p || undefined;
      if (!p) file.kind = 'added';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).trim());
      file.newPath = p || undefined;
      if (p) file.path = p;
      else file.kind = 'deleted';
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // skip `index`/mode/rename preamble between files

    const marker = line[0];
    if (marker === '+') {
      hunk.lines.push({ type: 'add', text: line.slice(1), newNo });
      newNo++;
      file.additions++;
    } else if (marker === '-') {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo });
      oldNo++;
      file.deletions++;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — a note, not a content line; skip numbering.
    } else {
      hunk.lines.push({ type: 'context', text: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }

  for (const f of files) if (!f.path) f.path = f.newPath ?? f.oldPath ?? '';
  return files;
}
