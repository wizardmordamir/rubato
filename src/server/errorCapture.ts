/**
 * Server-error → taskq capture (rubato wiring).
 *
 * Symmetric to cursedalchemy's: when an uncaught 5xx reaches the central route
 * error boundary (router.ts), file (or bump) ONE deduped "debug this" task — built
 * on the shared cwip primitive (`captureServerError`), the same logic + signature
 * the sibling app uses. Reuses the existing `getTaskqDb()` handle (the queue rubato
 * already drains — no second connection), never throws (capture must never break a
 * response), and is OFF unless `ERROR_AUTO_TASK` is truthy so the test/ft/e2e runs
 * that deliberately exercise 500 paths never spawn real tasks.
 */

import { captureServerError, type ServerErrorCaptureInput } from 'cwip/taskq';
import { optionalEnv } from '../api/env';
import { currentCorrelationId } from '../lib/correlation';
import { getTaskqDb } from './taskqDb';

const isTruthy = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'yes' || v === 'on';

export interface CaptureContext {
  method: string;
  url: string;
  status: number;
  error: unknown;
  /** Request body; handed to cwip for redaction before it's persisted. */
  payload?: unknown;
}

/** File/bump a deduped taskq debug task for a 5xx. No-op (and never throws) when disabled. */
export function captureServerErrorTask(ctx: CaptureContext): void {
  if (ctx.status < 500 || !isTruthy(optionalEnv('ERROR_AUTO_TASK'))) return;
  try {
    const err = ctx.error as { name?: string; message?: string; stack?: string } | string | undefined;
    const e = typeof err === 'object' ? err : undefined;
    const input: ServerErrorCaptureInput = {
      app: 'ru',
      method: ctx.method,
      url: ctx.url,
      status: ctx.status,
      name: e?.name,
      message: e?.message ?? (typeof err === 'string' ? err : undefined),
      stack: e?.stack,
      correlationId: currentCorrelationId() ?? null,
      payload: ctx.payload,
    };
    const result = captureServerError(getTaskqDb(), input);
    const verb = result.created ? 'filed' : result.reopened ? 're-queued (regression)' : 'bumped';
    console.error(`[errorCapture] ${verb} debug task #${result.taskId} (${result.slug}, ×${result.count})`);
  } catch (e) {
    // Capture must never break the response — swallow + log.
    console.error('[errorCapture] failed to file debug task:', e instanceof Error ? e.message : e);
  }
}
