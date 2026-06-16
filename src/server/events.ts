/**
 * Tiny in-process pub/sub for server events, backed by cwip's `createEventBus`
 * (the logic's canonical home). The WebSocket handler subscribes each
 * connection; the run logic emits lifecycle events. Kept as module-level
 * functions bound to one shared bus so call sites stay `emit(event)`.
 */

import { createEventBus } from 'cwip';
import type { ServerEvent } from '../shared/types';

const bus = createEventBus<ServerEvent>();

/** Register a listener; returns an unsubscribe function. */
export const subscribe = bus.subscribe;

/** Deliver an event to every current listener. */
export const emit = bus.emit;

/** Number of active listeners (handy for tests / diagnostics). */
export const listenerCount = bus.listenerCount;
