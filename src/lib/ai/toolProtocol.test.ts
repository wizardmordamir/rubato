import { describe, expect, test } from 'bun:test';
import { formatObservations, parseToolUse, renderToolInstructions, type ToolSpec, validateCall } from './toolProtocol';

describe('parseToolUse', () => {
  test('parses a fenced tool_use block', () => {
    const calls = parseToolUse(
      'Sure.\n```tool_use\n{"calls":[{"id":"c1","tool":"read_file","params":{"path":"a.ts"}}]}\n```',
    );
    expect(calls).toEqual([{ id: 'c1', tool: 'read_file', params: { path: 'a.ts' } }]);
  });

  test('falls back to a bare JSON object with calls', () => {
    const calls = parseToolUse('{"calls":[{"tool":"list_files","params":{}}]}');
    expect(calls?.[0]).toMatchObject({ tool: 'list_files', id: 'c1' });
  });

  test('returns null when there is no tool block (model is answering)', () => {
    expect(parseToolUse('There are 12 routes, defined in routes.tsx.')).toBeNull();
  });

  test('malformed JSON → null (no wedging the loop)', () => {
    expect(parseToolUse('```tool_use\n{calls: oops}\n```')).toBeNull();
  });

  test('skips calls without a tool name; assigns ids by position', () => {
    const calls = parseToolUse('{"calls":[{"params":{}},{"tool":"grep","params":{"pattern":"x"}}]}');
    expect(calls).toEqual([{ id: 'c2', tool: 'grep', params: { pattern: 'x' } }]);
  });
});

const spec: ToolSpec = {
  name: 'read_file',
  description: 'read a file',
  params: [
    { name: 'path', type: 'string', description: 'path', required: true },
    { name: 'start_line', type: 'number', description: 'from', required: false },
  ],
};

describe('validateCall', () => {
  test('coerces types and passes through valid params', () => {
    const r = validateCall(spec, { id: 'c1', tool: 'read_file', params: { path: 'a.ts', start_line: '10' } });
    expect(r).toEqual({ ok: true, params: { path: 'a.ts', start_line: 10 } });
  });

  test('rejects a missing required param with an actionable message', () => {
    const r = validateCall(spec, { id: 'c1', tool: 'read_file', params: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('path');
  });

  test('rejects a non-numeric number param', () => {
    const r = validateCall(spec, { id: 'c1', tool: 'read_file', params: { path: 'a', start_line: 'abc' } });
    expect(r.ok).toBe(false);
  });

  test('omits absent optional params', () => {
    const r = validateCall(spec, { id: 'c1', tool: 'read_file', params: { path: 'a.ts' } });
    expect(r).toEqual({ ok: true, params: { path: 'a.ts' } });
  });
});

describe('formatObservations / renderToolInstructions', () => {
  test('formats ok and error lines distinctly', () => {
    const out = formatObservations([
      { id: 'c1', tool: 'read_file', ok: true, content: 'contents' },
      { id: 'c2', tool: 'grep', ok: false, content: 'bad pattern' },
    ]);
    expect(out).toContain('[c1] read_file → contents');
    expect(out).toContain('[c2] grep → ERROR: bad pattern');
  });

  test('instructions list every tool and its params', () => {
    const out = renderToolInstructions([spec]);
    expect(out).toContain('read_file');
    expect(out).toContain('path (string, required)');
    expect(out).toContain('```tool_use');
  });
});
