/**
 * Pure curl-command / fetch-snippet generator. No IO — given a request shape it
 * returns an equivalent multi-line `curl` command and a runnable browser `fetch`
 * snippet. Shared between the web "Tools" tab (imported via @shared) and the
 * library export, so both render identical output. Ported from cursedalchemy.
 */

export type CurlKV = { key: string; value: string; enabled: boolean };

export type CurlAuth = {
  type: 'none' | 'basic' | 'bearer';
  username?: string;
  password?: string;
  token?: string;
};

export type CurlRequestInput = {
  method: string;
  url: string;
  queryParams: CurlKV[];
  headers: CurlKV[];
  body: string;
  bodyType: 'none' | 'raw' | 'json' | 'form';
  auth: CurlAuth;
  flags: string[];
};

/** Single-quote a shell argument safely (handles embedded quotes). */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const enabled = (rows: CurlKV[]) => rows.filter((r) => r.enabled && r.key.trim() !== '');

/** Append enabled query params to the URL, preserving any existing query string. */
const withQuery = (url: string, params: CurlKV[]): string => {
  const pairs = enabled(params).map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`);
  if (pairs.length === 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${pairs.join('&')}`;
};

export const buildCurl = (req: CurlRequestInput): string => {
  const parts: string[] = ['curl'];

  for (const flag of req.flags ?? []) parts.push(flag);

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET') parts.push('-X', method);

  parts.push(shq(withQuery(req.url || '', req.queryParams ?? [])));

  // Headers (track content-type so we don't duplicate one we add for json bodies).
  const headerKeys = new Set(enabled(req.headers ?? []).map((h) => h.key.toLowerCase()));
  for (const h of enabled(req.headers ?? [])) parts.push('-H', shq(`${h.key}: ${h.value}`));

  // Auth.
  if (req.auth?.type === 'basic' && (req.auth.username || req.auth.password)) {
    parts.push('-u', shq(`${req.auth.username ?? ''}:${req.auth.password ?? ''}`));
  } else if (req.auth?.type === 'bearer' && req.auth.token) {
    parts.push('-H', shq(`Authorization: Bearer ${req.auth.token}`));
  }

  // Body.
  if (req.bodyType && req.bodyType !== 'none' && req.body) {
    if (req.bodyType === 'json' && !headerKeys.has('content-type')) {
      parts.push('-H', shq('Content-Type: application/json'));
    }
    parts.push('--data', shq(req.body));
  }

  // Pretty multi-line output with backslash continuations.
  return parts.reduce((acc, part, i) => {
    if (i === 0) return part;
    // Keep a flag and its value on the same line (-X GET, -H '...', etc.).
    const prev = parts[i - 1];
    const isValueOfFlag = prev.startsWith('-') && !part.startsWith('-');
    return isValueOfFlag ? `${acc} ${part}` : `${acc} \\\n  ${part}`;
  }, '');
};

/** Quote a JS string literal (single-quoted), escaping backslashes, quotes, newlines. */
const jsq = (s: string): string =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

/**
 * Generate an equivalent browser `fetch` snippet from the same request. Mirrors
 * buildCurl: same URL (with query), headers, auth, and body.
 */
export const buildFetch = (req: CurlRequestInput): string => {
  const method = (req.method || 'GET').toUpperCase();
  const url = withQuery(req.url || '', req.queryParams ?? []);

  const headerLines: string[] = [];
  const seen = new Set<string>();
  for (const h of enabled(req.headers ?? [])) {
    headerLines.push(`    ${jsq(h.key)}: ${jsq(h.value)},`);
    seen.add(h.key.toLowerCase());
  }

  // Auth → header. Basic uses btoa() so the snippet is runnable as-is.
  if (req.auth?.type === 'basic' && (req.auth.username || req.auth.password)) {
    headerLines.push(
      `    'Authorization': 'Basic ' + btoa(${jsq(`${req.auth.username ?? ''}:${req.auth.password ?? ''}`)}),`,
    );
  } else if (req.auth?.type === 'bearer' && req.auth.token) {
    headerLines.push(`    'Authorization': ${jsq(`Bearer ${req.auth.token}`)},`);
  }

  // Body + the content-type curl would imply.
  const hasBody = Boolean(req.bodyType && req.bodyType !== 'none' && req.body);
  let bodyLine = '';
  if (hasBody) {
    if (req.bodyType === 'json') {
      if (!seen.has('content-type')) {
        headerLines.push(`    'Content-Type': 'application/json',`);
      }
      // Embed valid JSON as JSON.stringify(<object>); otherwise keep the raw string.
      try {
        bodyLine = `  body: JSON.stringify(${JSON.stringify(JSON.parse(req.body))}),`;
      } catch {
        bodyLine = `  body: ${jsq(req.body)},`;
      }
    } else {
      if (req.bodyType === 'form' && !seen.has('content-type')) {
        headerLines.push(`    'Content-Type': 'application/x-www-form-urlencoded',`);
      }
      bodyLine = `  body: ${jsq(req.body)},`;
    }
  }

  const optionLines = [`  method: ${jsq(method)},`];
  if (headerLines.length > 0) {
    optionLines.push(`  headers: {\n${headerLines.join('\n')}\n  },`);
  }
  if (bodyLine) optionLines.push(bodyLine);

  return [
    `fetch(${jsq(url)}, {`,
    ...optionLines,
    `})`,
    `  .then((res) => res.json())`,
    `  .then((data) => console.log(data))`,
    `  .catch((err) => console.error(err));`,
  ].join('\n');
};
