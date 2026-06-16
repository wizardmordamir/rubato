import { describe, expect, test } from 'bun:test';
import { Tracer } from './trace';

describe('Tracer', () => {
  test("span records a step and returns the fn's value", async () => {
    const t = new Tracer();
    const out = await t.span('seed', 'retrieval', async () => 42);
    expect(out).toBe(42);
    const trace = t.finish('self-ask');
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toMatchObject({ label: 'seed', kind: 'retrieval' });
    expect(trace.steps[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.totalMs).toBeGreaterThanOrEqual(0);
  });

  test('a thrown span is recorded with ok:false and rethrows', async () => {
    const t = new Tracer();
    await expect(
      t.span('planner', 'planner', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const trace = t.finish('self-ask');
    expect(trace.steps[0]).toMatchObject({ label: 'planner', kind: 'planner', ok: false });
  });

  test('lazy extra thunk is evaluated after the phase runs', async () => {
    const t = new Tracer();
    let count = 0;
    await t.span(
      'retrieval',
      'retrieval',
      async () => {
        count = 3;
      },
      () => ({ detail: `${count} chunks` }),
    );
    expect(t.finish('self-ask').steps[0].detail).toBe('3 chunks');
  });

  test('finish derives rounds from llm steps (agentic) and counts tool calls', async () => {
    const t = new Tracer();
    await t.span('Seed retrieval', 'retrieval', async () => undefined);
    await t.span('Model round 1', 'llm', async () => undefined);
    await t.span('Tool: search_repo', 'tool', async () => undefined);
    await t.span('Model round 2', 'llm', async () => undefined);
    const trace = t.finish('agentic', 'some-model');
    expect(trace.mode).toBe('agentic');
    expect(trace.model).toBe('some-model');
    expect(trace.rounds).toBe(2); // two llm rounds
    expect(trace.toolCalls).toBe(1);
  });

  test('finish derives rounds from retrieval steps for self-ask', async () => {
    const t = new Tracer();
    await t.span('Retrieval round 1', 'retrieval', async () => undefined);
    await t.span('Planner check', 'planner', async () => undefined);
    await t.span('Retrieval round 2', 'retrieval', async () => undefined);
    const trace = t.finish('self-ask');
    expect(trace.rounds).toBe(2); // two retrieval rounds, planner not counted
    expect(trace.toolCalls).toBe(0);
  });
});
