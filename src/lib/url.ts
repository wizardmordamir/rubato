/**
 * Normalize a user-typed URL so it's navigable. People type "example.com" or
 * "site.com/login" without a scheme; Playwright's page.goto then throws "Cannot
 * navigate to invalid URL" and the browser sits on about:blank. Prepend a scheme
 * when one is missing — http for localhost/loopback (dev servers), https
 * otherwise — and leave anything already schemed (incl. about:/data:/file:) alone.
 */

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SPECIAL_SCHEME = /^(about|data|blob|chrome|view-source|file|javascript):/i;
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?=$|[:/?#])/i;

export function normalizeUrl(input: string): string {
  const s = (input ?? '').trim();
  if (!s) return s;
  if (HAS_SCHEME.test(s) || SPECIAL_SCHEME.test(s)) return s;
  return `${LOOPBACK.test(s) ? 'http' : 'https'}://${s}`;
}
