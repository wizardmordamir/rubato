/**
 * Best-effort, forgiving parser that turns a curl command (the kind you copy from
 * browser devtools or paste from docs) into the canonical {@link HttpRequest}
 * model. Pure TS, no deps. It tokenizes respecting quotes and `\`-newline line
 * continuations, then folds recognized flags into the model and ignores the rest.
 * It never throws on weird input — it degrades, always returning a valid request
 * with every array present.
 */

import type { BodyConfig, HttpMethod, HttpRequest, KV, MultipartField } from './model';
import { emptyRequest, HTTP_METHODS } from './model';

/** A `-d`-style body value plus whether it came from `--data-urlencode` (always a form field). */
interface DataPiece {
  value: string;
  urlencode: boolean;
}

/** Parse a curl command string into the canonical HttpRequest model. */
export function parseCurl(curl: string): HttpRequest {
  const req = emptyRequest();
  const tokens = tokenize(curl);

  // Strip a leading `curl` token (case-insensitive).
  if (tokens.length && tokens[0].toLowerCase() === 'curl') tokens.shift();

  let explicitMethod: HttpMethod | null = null;
  let url = '';
  const dataPieces: DataPiece[] = [];
  const multipart: MultipartField[] = [];
  let sawBody = false;
  let dataAsQuery = false; // -G / --get

  const next = (i: number): string => (i + 1 < tokens.length ? tokens[i + 1] : '');

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // --flag=value form: normalize into flag + value.
    let flag = tok;
    let inlineValue: string | null = null;
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=');
      flag = tok.slice(0, eq);
      inlineValue = tok.slice(eq + 1);
    }

    const takeValue = (): string => {
      if (inlineValue !== null) return inlineValue;
      const v = next(i);
      i++;
      return v;
    };

    switch (flag) {
      case '-X':
      case '--request': {
        const m = takeValue().toUpperCase();
        if ((HTTP_METHODS as string[]).includes(m)) explicitMethod = m as HttpMethod;
        break;
      }
      case '--url': {
        url = takeValue();
        break;
      }
      case '-H':
      case '--header': {
        const raw = takeValue();
        applyHeader(req, raw);
        break;
      }
      case '-u':
      case '--user': {
        const cred = takeValue();
        const idx = cred.indexOf(':');
        const username = idx >= 0 ? cred.slice(0, idx) : cred;
        const password = idx >= 0 ? cred.slice(idx + 1) : '';
        req.auth = { type: 'basic', username, password };
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary': {
        dataPieces.push({ value: takeValue(), urlencode: false });
        sawBody = true;
        break;
      }
      case '--data-urlencode': {
        dataPieces.push({ value: takeValue(), urlencode: true });
        sawBody = true;
        break;
      }
      case '-F':
      case '--form': {
        const field = parseFormField(takeValue());
        if (field) multipart.push(field);
        sawBody = true;
        break;
      }
      case '-G':
      case '--get': {
        dataAsQuery = true;
        break;
      }
      case '-I':
      case '--head': {
        explicitMethod = 'HEAD';
        break;
      }
      // Flags that take a value we don't model — consume the value so it isn't
      // mistaken for the URL.
      case '-A':
      case '--user-agent':
      case '-e':
      case '--referer':
      case '-b':
      case '--cookie':
      case '-c':
      case '--cookie-jar':
      case '-o':
      case '--output':
      case '-w':
      case '--write-out':
      case '-m':
      case '--max-time':
      case '--connect-timeout':
      case '--retry':
      case '-x':
      case '--proxy': {
        takeValue();
        break;
      }
      // Valueless flags we ignore.
      case '-L':
      case '--location':
      case '-k':
      case '--insecure':
      case '-s':
      case '--silent':
      case '-i':
      case '--include':
      case '-v':
      case '--verbose':
      case '--compressed':
      case '-f':
      case '--fail':
      case '-g':
      case '--globoff':
        break;
      default: {
        if (tok.startsWith('-')) {
          // Unknown flag — ignore gracefully (don't swallow a following token).
          break;
        }
        // First bare token is the URL.
        if (!url) url = tok;
        break;
      }
    }
  }

  // URL + query extraction.
  applyUrl(req, url);

  // Body assembly.
  if (multipart.length) {
    req.body = { type: 'multipart', fields: multipart };
  } else if (dataPieces.length) {
    if (dataAsQuery) {
      // -G: send the data as query params instead of a body.
      for (const piece of dataPieces) {
        for (const row of parseFormFields(piece.value)) req.query.push(row);
      }
    } else {
      req.body = assembleDataBody(dataPieces);
    }
  }

  // Method resolution.
  if (explicitMethod) {
    req.method = explicitMethod;
  } else if (sawBody && !dataAsQuery) {
    req.method = 'POST';
  } else {
    req.method = 'GET';
  }

  return req;
}

/** Tokenize a shell-ish string respecting quotes and `\`-newline continuations. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false; // whether `cur` represents a (possibly empty) started token
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && i + 1 < input.length) {
        // In double quotes, a backslash escapes the next char.
        cur += input[i + 1];
        i++;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }

    if (ch === '\\') {
      const nextCh = input[i + 1];
      if (nextCh === '\n' || nextCh === '\r') {
        // Line continuation — swallow the backslash and newline(s).
        i++;
        if (nextCh === '\r' && input[i + 1] === '\n') i++;
        continue;
      }
      // Escaped char outside quotes.
      if (nextCh !== undefined) {
        cur += nextCh;
        has = true;
        i++;
        continue;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }

    cur += ch;
    has = true;
  }

  if (has) tokens.push(cur);
  return tokens;
}

/** Fold a `K: V` header into the model, special-casing bearer auth. */
function applyHeader(req: HttpRequest, raw: string): void {
  const idx = raw.indexOf(':');
  if (idx < 0) return;
  const key = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!key) return;

  if (key.toLowerCase() === 'authorization') {
    const m = /^bearer\s+(.+)$/i.exec(value);
    if (m) {
      req.auth = { type: 'bearer', token: m[1].trim() };
      return; // drop the header
    }
  }
  req.headers.push({ key, value, enabled: true });
}

/** Set req.url to the bare URL and pull any existing query string into query rows. */
function applyUrl(req: HttpRequest, url: string): void {
  if (!url) {
    req.url = '';
    return;
  }
  const qIdx = url.indexOf('?');
  if (qIdx < 0) {
    req.url = url;
    return;
  }
  req.url = url.slice(0, qIdx);
  const qs = url.slice(qIdx + 1);
  for (const pair of qs.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : '';
    req.query.push({ key: safeDecode(key), value: safeDecode(value), enabled: true });
  }
}

/** Build the body from one or more `-d`-style pieces. */
function assembleDataBody(pieces: DataPiece[]): BodyConfig {
  // Any --data-urlencode forces form treatment; otherwise inspect the joined text.
  const anyUrlencode = pieces.some((p) => p.urlencode);
  const joined = pieces.map((p) => p.value).join('&');
  const trimmed = joined.trim();

  if (!anyUrlencode && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return { type: 'json', text: joined };
  }

  if (anyUrlencode || looksLikeForm(joined)) {
    return { type: 'form', fields: parseFormFields(joined) };
  }

  return { type: 'raw', text: joined, contentType: 'text/plain' };
}

/** Does the text look like `k=v&k2=v2`? */
function looksLikeForm(text: string): boolean {
  if (!text.includes('=')) return false;
  for (const pair of text.split('&')) {
    if (pair === '') continue;
    if (!pair.includes('=')) return false;
  }
  return true;
}

/** Parse `k=v&k2=v2` into enabled KV rows, decoding values. */
function parseFormFields(text: string): KV[] {
  const rows: KV[] = [];
  for (const pair of text.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : '';
    rows.push({ key: safeDecode(key), value: safeDecode(value), enabled: true });
  }
  return rows;
}

/** Parse a single `-F`/`--form` spec into a multipart field. */
function parseFormField(spec: string): MultipartField | null {
  const eq = spec.indexOf('=');
  if (eq < 0) return null;
  const key = spec.slice(0, eq);
  const rest = spec.slice(eq + 1);
  if (rest.startsWith('@')) {
    // File upload: @filename, possibly with ;type=... extras we drop.
    const filename = rest.slice(1).split(';')[0];
    return { kind: 'file', key, filename, contentBase64: '', enabled: true };
  }
  return { kind: 'text', key, value: rest, enabled: true };
}

/** decodeURIComponent that degrades to the raw string on malformed input. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}
