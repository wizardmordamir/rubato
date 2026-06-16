/**
 * Execute an HttpRequest and return an HttpResult. Runs server-side (Bun fetch),
 * so the builder can hit any host without CORS limits — rubato's edge over a
 * browser-only request tool. Read-only by nature; bounded by a timeout.
 */

import { enabledRows, type HttpRequest, type HttpResult } from '../shared/request/model';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024; // guard against an enormous body

/** Build the final URL: base + enabled query params + apiKey-in-query auth. */
function buildUrl(req: HttpRequest): string {
  const params: Array<[string, string]> = enabledRows(req.query).map((p) => [p.key, p.value]);
  if (req.auth.type === 'apiKey' && req.auth.in === 'query' && req.auth.key.trim()) {
    params.push([req.auth.key, req.auth.value]);
  }
  if (params.length === 0) return req.url;
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return req.url.includes('?') ? `${req.url}&${qs}` : `${req.url}?${qs}`;
}

/** Headers from enabled rows + auth, lower-cased keys tracked to avoid dupes. */
function buildHeaders(req: HttpRequest): Headers {
  const headers = new Headers();
  for (const h of enabledRows(req.headers)) headers.set(h.key, h.value);
  if (req.auth.type === 'basic' && (req.auth.username || req.auth.password)) {
    headers.set('Authorization', `Basic ${btoa(`${req.auth.username}:${req.auth.password}`)}`);
  } else if (req.auth.type === 'bearer' && req.auth.token) {
    headers.set('Authorization', `Bearer ${req.auth.token}`);
  } else if (req.auth.type === 'apiKey' && req.auth.in === 'header' && req.auth.key.trim()) {
    headers.set(req.auth.key, req.auth.value);
  }
  return headers;
}

/** Build the fetch body, setting a content-type only when the user didn't. */
function buildBody(req: HttpRequest, headers: Headers): BodyInit | undefined {
  const body = req.body;
  switch (body.type) {
    case 'none':
      return undefined;
    case 'json':
      if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');
      return body.text;
    case 'raw':
      if (!headers.has('content-type') && body.contentType) headers.set('Content-Type', body.contentType);
      return body.text;
    case 'form': {
      const params = new URLSearchParams();
      for (const f of enabledRows(body.fields)) params.append(f.key, f.value);
      return params; // fetch sets application/x-www-form-urlencoded
    }
    case 'multipart': {
      const form = new FormData();
      for (const f of body.fields) {
        if (!f.enabled || !f.key.trim()) continue;
        if (f.kind === 'text') {
          form.append(f.key, f.value);
        } else {
          const bytes = Uint8Array.from(Buffer.from(f.contentBase64, 'base64'));
          form.append(f.key, new Blob([bytes], { type: f.contentType || 'application/octet-stream' }), f.filename);
        }
      }
      headers.delete('content-type'); // let fetch set the multipart boundary
      return form;
    }
  }
}

export async function runHttpRequest(req: HttpRequest): Promise<HttpResult> {
  const startedAt = Date.now();
  const headers = buildHeaders(req);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : buildBody(req, headers);
  const url = buildUrl(req);

  let res: Response;
  try {
    res = await fetch(url, { method: req.method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    return {
      status: 0,
      statusText: isTimeout ? 'Timeout' : 'Network Error',
      ok: false,
      headers: [],
      body: '',
      contentType: '',
      sizeBytes: 0,
      durationMs: Date.now() - startedAt,
      error: isTimeout
        ? `request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'fetch failed',
    };
  }

  // Read the body, capped.
  let text = '';
  try {
    const buf = await res.arrayBuffer();
    text =
      buf.byteLength > MAX_RESPONSE_BYTES
        ? `${new TextDecoder().decode(buf.slice(0, MAX_RESPONSE_BYTES))}\n…[response truncated]`
        : new TextDecoder().decode(buf);
  } catch {
    text = '';
  }

  return {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    headers: [...res.headers.entries()],
    body: text,
    contentType: res.headers.get('content-type') ?? '',
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    durationMs: Date.now() - startedAt,
  };
}
