/**
 * Claude API rate-limit probe: makes a lightweight `count_tokens` call (no
 * inference cost) to capture the current per-minute token / request limits that
 * Anthropic returns in response headers, then caches for 60 s so the Usage tab
 * can refresh without spamming the API.
 *
 * Returns a `ClaudeRateLimitInfo` whether or not the API key is present; the
 * caller decides what to surface when `hasApiKey` is false or `error` is set.
 */

import type { ClaudeRateLimitInfo } from '../shared/orchestration';

const CACHE_TTL_MS = 60_000;

interface Cache {
  data: ClaudeRateLimitInfo;
  fetchedAt: number;
}

let _cache: Cache | null = null;

/** Invalidate the in-process cache (useful in tests). */
export function invalidateClaudeUsageCache(): void {
  _cache = null;
}

/** Probe Anthropic's API to capture current rate-limit headers. Cached 60 s. */
export async function getClaudeRateLimits(): Promise<ClaudeRateLimitInfo> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fetchedAt = new Date().toISOString();

  if (!apiKey) {
    const data: ClaudeRateLimitInfo = {
      hasApiKey: false,
      fetchedAt,
      limitTokensPerMinute: null,
      remainingTokensPerMinute: null,
      resetTokensAt: null,
      limitRequestsPerMinute: null,
      remainingRequestsPerMinute: null,
      resetRequestsAt: null,
    };
    _cache = { data, fetchedAt: Date.now() };
    return data;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const parseNum = (v: string | null): number | null => {
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const data: ClaudeRateLimitInfo = {
      hasApiKey: true,
      fetchedAt,
      limitTokensPerMinute: parseNum(res.headers.get('x-ratelimit-limit-tokens')),
      remainingTokensPerMinute: parseNum(res.headers.get('x-ratelimit-remaining-tokens')),
      resetTokensAt: res.headers.get('x-ratelimit-reset-tokens') ?? null,
      limitRequestsPerMinute: parseNum(res.headers.get('x-ratelimit-limit-requests')),
      remainingRequestsPerMinute: parseNum(res.headers.get('x-ratelimit-remaining-requests')),
      resetRequestsAt: res.headers.get('x-ratelimit-reset-requests') ?? null,
    };

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error?.message) errMsg = body.error.message;
      } catch {
        // ignore parse failure
      }
      data.error = errMsg;
    }

    _cache = { data, fetchedAt: Date.now() };
    return data;
  } catch (e) {
    const data: ClaudeRateLimitInfo = {
      hasApiKey: true,
      fetchedAt,
      limitTokensPerMinute: null,
      remainingTokensPerMinute: null,
      resetTokensAt: null,
      limitRequestsPerMinute: null,
      remainingRequestsPerMinute: null,
      resetRequestsAt: null,
      error: e instanceof Error ? e.message : String(e),
    };
    _cache = { data, fetchedAt: Date.now() };
    return data;
  }
}
