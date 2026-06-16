/**
 * A tiny timing recorder for the ask pipeline. Each ask builds one `Tracer`,
 * wraps its phases in `span()` (or `mark()` for an already-elapsed segment), and
 * `finish()` rolls the steps into a `MessageTrace` that rides along on the
 * assistant message — surfaced in the UI's debug panel. Pure measurement: a
 * tracer never alters the answer, so instrumentation can't break an ask.
 */

import type { MessageTrace, TraceStep } from '../shared/types';

/** Extra step fields, given directly or as a thunk evaluated after the phase. */
type Extra = Partial<TraceStep> | (() => Partial<TraceStep>);

const resolveExtra = (extra?: Extra): Partial<TraceStep> => (typeof extra === 'function' ? extra() : (extra ?? {}));

export class Tracer {
  private readonly t0 = Date.now();
  private readonly steps: TraceStep[] = [];

  /** Record a step that took `durationMs`, starting `startMs` after t0. */
  mark(label: string, kind: TraceStep['kind'], startMs: number, durationMs: number, extra?: Partial<TraceStep>): void {
    this.steps.push({ label, kind, startMs, durationMs, ...extra });
  }

  /**
   * Time an async phase, recording one step whether it resolves or throws.
   * `extra` may be a thunk so its detail can reflect the phase's outcome.
   */
  async span<T>(label: string, kind: TraceStep['kind'], fn: () => Promise<T>, extra?: Extra): Promise<T> {
    const startMs = Date.now() - this.t0;
    const at = Date.now();
    try {
      const out = await fn();
      this.mark(label, kind, startMs, Date.now() - at, resolveExtra(extra));
      return out;
    } catch (err) {
      this.mark(label, kind, startMs, Date.now() - at, { ...resolveExtra(extra), ok: false });
      throw err;
    }
  }

  /** Roll the recorded steps into a trace. `rounds`/`toolCalls` derive from kinds. */
  finish(mode: MessageTrace['mode'], model?: string): MessageTrace {
    const rounds = this.steps.filter((s) => s.kind === (mode === 'agentic' ? 'llm' : 'retrieval')).length;
    const toolCalls = this.steps.filter((s) => s.kind === 'tool').length;
    return { totalMs: Date.now() - this.t0, mode, rounds, toolCalls, model, steps: this.steps };
  }
}
