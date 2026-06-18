/**
 * App Map: a compact markdown overview of an app — its top-level directory
 * shape, UI routes, and server endpoints — prepended to the chat system prompt.
 *
 * Without it the model is blind to the app's overall structure: it only ever
 * sees the handful of chunks retrieval surfaced, so a vague question ("the
 * privacy page") that doesn't lexically match the real route ("/private") gets a
 * confidently wrong answer. The map gives global awareness *before* retrieval, so
 * the model can route a question to the right area and recognize references.
 *
 * Pure over already-read text files (the indexer passes the files it just read),
 * so there's no second filesystem walk and the extraction is unit-testable. The
 * output is hard-capped to a small token budget so it can't crowd code out of the
 * context window.
 */

/** A file the map is built from (relative path + text content). */
export interface AppMapFile {
  relativePath: string;
  content: string;
}

export interface AppMapOptions {
  /**
   * Token budget for the whole map (default 1500 ≈ 6000 chars). Generous on
   * purpose: the per-section caps below are the real bound, and against a 32k
   * context window a complete route list is far more valuable than shaving tokens.
   * Truncation here is only a final safety net.
   */
  maxTokens?: number;
  /** Max directory lines listed (default 24). */
  maxDirs?: number;
  /** Max routes/endpoints listed each (default 60). */
  maxRoutes?: number;
}

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|py|go|rb|rs|java|kt|php)$/i;

// UI routes: react-router `path="…"` / `to="/…"`, and `<Route path="/…">`.
const UI_ROUTE_RE = /(?:\bpath|\bto)\s*[:=]\s*["'`](\/[A-Za-z0-9_\-/:*.]*)["'`]/g;
// Route constants: `export const fooRoute = '/foo'` / `pageRoute = "/x"` — many apps
// reference routes by constant (path: fooRoute) so the literal never appears at the path.
const ROUTE_CONST_RE = /\b\w*(?:[Rr]oute|pageRoute)\b\s*=\s*["'`](\/[A-Za-z0-9_\-/:*.]*)["'`]/g;
// Express-style endpoints: router.get('/x') / app.post("/y").
const ENDPOINT_RE = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
// cursedalchemy's buildRoutes(method, url, …) twin-registration helper.
const BUILD_ROUTES_RE = /\bbuildRoutes\s*\(\s*["'`]?(\w+)["'`]?\s*,\s*["'`]([^"'`]+)["'`]/gi;

/** Collect every capture of a global regex over a string. */
function matchAll(content: string, re: RegExp, map: (m: RegExpExecArray) => string | null): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex scan
  while ((m = re.exec(content)) !== null) {
    const v = map(m);
    if (v) out.push(v);
  }
  return out;
}

/** Top-level + second-level directories with file counts (compact tree). */
function directoryTree(files: AppMapFile[], maxDirs: number): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const segs = f.relativePath.split('/');
    if (segs.length < 2) continue; // a root-level file has no dir
    for (let depth = 1; depth <= Math.min(2, segs.length - 1); depth++) {
      const dir = segs.slice(0, depth).join('/');
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxDirs)
    .map(([dir, n]) => `${'  '.repeat(dir.split('/').length - 1)}- ${dir}/ (${n})`);
}

/** Approximate token→char budget truncation (≈4 chars/token), with a marker. */
function truncate(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n… (app map truncated)`;
}

/** Build the markdown App Map from a set of files. Returns '' when nothing useful was found. */
export function buildAppMap(files: AppMapFile[], opts: AppMapOptions = {}): string {
  const maxTokens = opts.maxTokens ?? 1500;
  const maxDirs = opts.maxDirs ?? 24;
  const maxRoutes = opts.maxRoutes ?? 60;

  const uiRoutes = new Set<string>();
  const endpoints = new Set<string>();
  for (const f of files) {
    if (!SOURCE_EXT.test(f.relativePath)) continue;
    for (const r of matchAll(f.content, UI_ROUTE_RE, (m) => m[1])) uiRoutes.add(r);
    for (const r of matchAll(f.content, ROUTE_CONST_RE, (m) => m[1])) uiRoutes.add(r);
    for (const e of matchAll(f.content, ENDPOINT_RE, (m) => `${m[1].toUpperCase()} ${m[2]}`)) endpoints.add(e);
    for (const e of matchAll(f.content, BUILD_ROUTES_RE, (m) => `${m[1].toUpperCase()} ${m[2]}`)) endpoints.add(e);
  }

  const dirs = directoryTree(files, maxDirs);
  const routeList = [...uiRoutes].sort().slice(0, maxRoutes);
  const endpointList = [...endpoints].sort().slice(0, maxRoutes);
  if (!dirs.length && !routeList.length && !endpointList.length) return '';

  const sections: string[] = ['### App map'];
  if (dirs.length) sections.push(`**Directory structure:**\n${dirs.join('\n')}`);
  if (routeList.length) sections.push(`**UI routes:**\n${routeList.map((r) => `- ${r}`).join('\n')}`);
  if (endpointList.length) sections.push(`**Server endpoints:**\n${endpointList.map((e) => `- ${e}`).join('\n')}`);
  return truncate(sections.join('\n\n'), maxTokens);
}
