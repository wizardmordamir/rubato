/**
 * Per-request correlation context, carried implicitly via AsyncLocalStorage so a
 * correlation id flows through the whole async call tree of a request — into
 * diagnostics, the log accumulator, and captured outbound fetch/DB records —
 * without threading an id parameter through every function. The id is minted once
 * per inbound request in router.route() and is the key that ties a request's
 * server logs to the outbound calls it made.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface CorrelationCtx {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationCtx>();

/** Run `fn` (and everything it awaits) under the given correlation id. */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** The correlation id of the in-flight request, or undefined outside one. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
