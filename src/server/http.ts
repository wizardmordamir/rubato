/**
 * Small HTTP helpers shared by the server route handlers, so each route module
 * doesn't redefine its own JSON-response and body-parse boilerplate.
 */

import { AppError, type AppErrorOptions, ForbiddenError, NotFoundError, toErrorEnvelope } from 'cwip';

/** A JSON response with the right content-type. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const errorByStatus: Record<number, new (m?: string, o?: AppErrorOptions) => AppError> = {
  403: ForbiddenError,
  404: NotFoundError,
};

/**
 * The single error-response builder: emits the canonical `{ error: { name,
 * message, code?, status, isOperational, timestamp, context? } }` envelope (cwip
 * `toErrorEnvelope`) so every failed request across rubato (and the other apps)
 * has one shape. Common statuses get a coded subclass (404 → NOT_FOUND, …); the
 * rest are a plain `AppError` carrying the status. `context` folds in any extra
 * structured fields a route used to attach alongside the message.
 */
export function jsonError(message: string | undefined, status = 500, context?: Record<string, unknown>): Response {
  const msg = message || 'Request failed';
  const Ctor = errorByStatus[status];
  const err = Ctor ? new Ctor(msg, { context }) : new AppError(msg, { status, context });
  return json(toErrorEnvelope(err), status);
}

/** Parse a JSON request body; returns null on malformed JSON (caller maps to 400). */
export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
