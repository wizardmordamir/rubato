/**
 * Pure transforms over the canonical HttpRequest model: export to a multi-line
 * `curl` command and a runnable browser `fetch` snippet, substitute `{{var}}`
 * placeholders from an environment, and wrap/unwrap the portable share file.
 * No React, no Node, no deps — shared between the web UI (via @shared), the
 * server, and a future standalone "request kit" package. Shell-escaping style
 * (single-quoted args) mirrors src/shared/tools/curl.ts for consistent output.
 */

import {
  type AuthConfig,
  type BodyConfig,
  enabledRows,
  type HttpRequest,
  type KV,
  type MultipartField,
  type RequestFile,
} from './model';

/** Single-quote a shell argument safely (handles embedded quotes). */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Quote a JS string literal (single-quoted), escaping backslashes, quotes, newlines. */
const jsq = (s: string): string =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

/** Append enabled query params to the URL, preserving any existing query string. */
const withQuery = (url: string, params: KV[]): string => {
  const pairs = enabledRows(params).map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`);
  if (pairs.length === 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${pairs.join('&')}`;
};

/** Append a single raw `k=v` pair to a URL (used for apiKey-in-query). */
const appendQueryPair = (url: string, key: string, value: string): string => {
  const pair = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${pair}`;
};

/** Enabled multipart fields (key non-empty). */
const enabledFields = (fields: MultipartField[]): MultipartField[] =>
  fields.filter((f) => f.enabled && f.key.trim() !== '');

/** Build the request URL: enabled query params plus an apiKey-in-query, if any. */
const buildUrl = (req: HttpRequest): string => {
  let url = withQuery(req.url || '', req.query ?? []);
  if (req.auth.type === 'apiKey' && req.auth.in === 'query' && req.auth.key) {
    url = appendQueryPair(url, req.auth.key, req.auth.value);
  }
  return url;
};

/**
 * Generate an equivalent multi-line `curl` command from a request. Backslash
 * continuations keep a flag and its value on one line.
 */
export function buildCurl(req: HttpRequest): string {
  const parts: string[] = ['curl'];

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET') parts.push('-X', method);

  parts.push(shq(buildUrl(req)));

  // Headers (track content-type so we don't duplicate one we add for bodies).
  const headerKeys = new Set(enabledRows(req.headers ?? []).map((h) => h.key.toLowerCase()));
  for (const h of enabledRows(req.headers ?? [])) parts.push('-H', shq(`${h.key}: ${h.value}`));

  // Auth.
  const auth = req.auth;
  if (auth.type === 'basic' && (auth.username || auth.password)) {
    parts.push('-u', shq(`${auth.username ?? ''}:${auth.password ?? ''}`));
  } else if (auth.type === 'bearer' && auth.token) {
    parts.push('-H', shq(`Authorization: Bearer ${auth.token}`));
  } else if (auth.type === 'apiKey' && auth.in === 'header' && auth.key) {
    parts.push('-H', shq(`${auth.key}: ${auth.value}`));
  }

  // Body.
  const body = req.body;
  if (body.type === 'json' && body.text) {
    if (!headerKeys.has('content-type')) parts.push('-H', shq('Content-Type: application/json'));
    parts.push('--data', shq(body.text));
  } else if (body.type === 'raw' && body.text) {
    if (body.contentType && !headerKeys.has('content-type')) {
      parts.push('-H', shq(`Content-Type: ${body.contentType}`));
    }
    parts.push('--data', shq(body.text));
  } else if (body.type === 'form') {
    for (const f of enabledRows(body.fields)) {
      parts.push('--data', shq(`${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`));
    }
  } else if (body.type === 'multipart') {
    for (const f of enabledFields(body.fields)) {
      if (f.kind === 'file') parts.push('-F', shq(`${f.key}=@${f.filename}`));
      else parts.push('-F', shq(`${f.key}=${f.value}`));
    }
  }

  // Pretty multi-line output with backslash continuations.
  return parts.reduce((acc, part, i) => {
    if (i === 0) return part;
    const prev = parts[i - 1];
    const isValueOfFlag = prev.startsWith('-') && !part.startsWith('-');
    return isValueOfFlag ? `${acc} ${part}` : `${acc} \\\n  ${part}`;
  }, '');
}

/**
 * Generate an equivalent runnable browser `fetch` snippet. Mirrors buildCurl:
 * same URL (with query + apiKey-query), headers, auth, and body.
 */
export function buildFetch(req: HttpRequest): string {
  const method = (req.method || 'GET').toUpperCase();
  const url = buildUrl(req);

  const headerLines: string[] = [];
  const seen = new Set<string>();
  for (const h of enabledRows(req.headers ?? [])) {
    headerLines.push(`    ${jsq(h.key)}: ${jsq(h.value)},`);
    seen.add(h.key.toLowerCase());
  }

  // Auth → header. Basic uses btoa() so the snippet is runnable as-is.
  const auth = req.auth;
  if (auth.type === 'basic' && (auth.username || auth.password)) {
    headerLines.push(`    'Authorization': 'Basic ' + btoa(${jsq(`${auth.username ?? ''}:${auth.password ?? ''}`)}),`);
  } else if (auth.type === 'bearer' && auth.token) {
    headerLines.push(`    'Authorization': ${jsq(`Bearer ${auth.token}`)},`);
  } else if (auth.type === 'apiKey' && auth.in === 'header' && auth.key) {
    headerLines.push(`    ${jsq(auth.key)}: ${jsq(auth.value)},`);
    seen.add(auth.key.toLowerCase());
  }

  // Body + the content-type curl would imply.
  const body = req.body;
  let bodyLine = '';
  if (body.type === 'json' && body.text) {
    if (!seen.has('content-type')) headerLines.push(`    'Content-Type': 'application/json',`);
    // Embed valid JSON as JSON.stringify(<object>); otherwise keep the raw string.
    try {
      bodyLine = `  body: JSON.stringify(${JSON.stringify(JSON.parse(body.text))}),`;
    } catch {
      bodyLine = `  body: ${jsq(body.text)},`;
    }
  } else if (body.type === 'raw' && body.text) {
    if (body.contentType && !seen.has('content-type'))
      headerLines.push(`    'Content-Type': ${jsq(body.contentType)},`);
    bodyLine = `  body: ${jsq(body.text)},`;
  } else if (body.type === 'form') {
    const pairs = enabledRows(body.fields).map((f) => `    ${jsq(f.key)}: ${jsq(f.value)},`);
    bodyLine = pairs.length
      ? `  body: new URLSearchParams({\n${pairs.join('\n')}\n  }),`
      : `  body: new URLSearchParams({}),`;
  } else if (body.type === 'multipart') {
    bodyLine = 'MULTIPART'; // sentinel; expanded below into multiple lines.
  }

  const optionLines = [`  method: ${jsq(method)},`];
  if (headerLines.length > 0) optionLines.push(`  headers: {\n${headerLines.join('\n')}\n  },`);

  // Multipart needs a pre-built FormData; emit it before the fetch() call.
  const preamble: string[] = [];
  if (body.type === 'multipart') {
    preamble.push('const formData = new FormData();');
    for (const f of enabledFields(body.fields)) {
      if (f.kind === 'file') {
        // The browser supplies the File object; we can't embed bytes in a snippet.
        preamble.push(`// Attach the file for ${jsq(f.key)} (filename: ${jsq(f.filename)}):`);
        preamble.push(`// formData.append(${jsq(f.key)}, fileInput.files[0], ${jsq(f.filename)});`);
      } else {
        preamble.push(`formData.append(${jsq(f.key)}, ${jsq(f.value)});`);
      }
    }
    preamble.push('');
  }

  if (bodyLine === 'MULTIPART') optionLines.push(`  body: formData,`);
  else if (bodyLine) optionLines.push(bodyLine);

  const fetchCall = [
    `fetch(${jsq(url)}, {`,
    ...optionLines,
    `})`,
    `  .then((res) => res.json())`,
    `  .then((data) => console.log(data))`,
    `  .catch((err) => console.error(err));`,
  ].join('\n');

  return preamble.length ? `${preamble.join('\n')}\n${fetchCall}` : fetchCall;
}

/** Replace every `{{key}}` with vars[key]; leave unknown placeholders untouched. */
const subst = (s: string, vars: Record<string, string>): string =>
  s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) => (key in vars ? vars[key] : whole));

const substKV = (rows: KV[], vars: Record<string, string>): KV[] =>
  rows.map((r) => ({ key: subst(r.key, vars), value: subst(r.value, vars), enabled: r.enabled }));

const substAuth = (auth: AuthConfig, vars: Record<string, string>): AuthConfig => {
  switch (auth.type) {
    case 'basic':
      return { type: 'basic', username: subst(auth.username, vars), password: subst(auth.password, vars) };
    case 'bearer':
      return { type: 'bearer', token: subst(auth.token, vars) };
    case 'apiKey':
      return { type: 'apiKey', key: subst(auth.key, vars), value: subst(auth.value, vars), in: auth.in };
    default:
      return { type: 'none' };
  }
};

const substBody = (body: BodyConfig, vars: Record<string, string>): BodyConfig => {
  switch (body.type) {
    case 'json':
      return { type: 'json', text: subst(body.text, vars) };
    case 'raw':
      return { type: 'raw', text: subst(body.text, vars), contentType: body.contentType };
    case 'form':
      return { type: 'form', fields: substKV(body.fields, vars) };
    case 'multipart':
      return {
        type: 'multipart',
        fields: body.fields.map((f) =>
          f.kind === 'text'
            ? { kind: 'text', key: subst(f.key, vars), value: subst(f.value, vars), enabled: f.enabled }
            : { ...f },
        ),
      };
    default:
      return { type: 'none' };
  }
};

/**
 * Return a deep copy of the request with every `{{key}}` replaced by vars[key]
 * across url, query, headers, auth, and body text/fields. File field content,
 * filename, and contentType are left untouched. Pure — the input is not mutated.
 */
export function interpolate(req: HttpRequest, vars: Record<string, string>): HttpRequest {
  return {
    method: req.method,
    url: subst(req.url, vars),
    query: substKV(req.query ?? [], vars),
    headers: substKV(req.headers ?? [], vars),
    auth: substAuth(req.auth, vars),
    body: substBody(req.body, vars),
  };
}

/** Wrap a request in the portable share-file envelope. */
export function toRequestFile(req: HttpRequest, name?: string): RequestFile {
  return { kind: 'rubato.request', version: 1, name, request: req };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Validate and unwrap a portable share file back into an HttpRequest. Throws on
 * a malformed file; normalizes missing optional arrays to [].
 */
export function parseRequestFile(data: unknown): HttpRequest {
  if (!isObject(data) || data.kind !== 'rubato.request' || !isObject(data.request)) {
    throw new Error('not a rubato request file');
  }
  const r = data.request as Partial<HttpRequest>;
  return {
    method: (r.method ?? 'GET') as HttpRequest['method'],
    url: typeof r.url === 'string' ? r.url : '',
    query: Array.isArray(r.query) ? r.query : [],
    headers: Array.isArray(r.headers) ? r.headers : [],
    auth: r.auth ?? { type: 'none' },
    body: r.body ?? { type: 'none' },
  };
}
