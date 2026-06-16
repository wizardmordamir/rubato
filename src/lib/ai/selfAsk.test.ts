import { describe, expect, test } from 'bun:test';
import { buildPlannerPrompt, parseDecision } from './selfAsk';
import type { RetrievedChunk } from './types';

const chunk = (path: string, startLine: number, text = 'code'): RetrievedChunk => ({
  relativePath: path,
  startLine,
  endLine: startLine + 9,
  text,
  score: 1,
});

describe('buildPlannerPrompt', () => {
  test('includes the question and a path:line inventory', () => {
    const [system, user] = buildPlannerPrompt('how many routes?', [chunk('routes.tsx', 1)]);
    expect(system.role).toBe('system');
    expect(user.content).toContain('how many routes?');
    expect(user.content).toContain('routes.tsx:1-10');
  });

  test('notes when nothing has been gathered', () => {
    const [, user] = buildPlannerPrompt('q', []);
    expect(user.content).toContain('(nothing yet)');
  });
});

describe('parseDecision', () => {
  test('reads an explicit need-more verdict with queries', () => {
    const d = parseDecision('{"sufficient": false, "queries": ["route definitions", "router config"]}');
    expect(d.sufficient).toBe(false);
    expect(d.queries).toEqual(['route definitions', 'router config']);
  });

  test('extracts JSON even with surrounding prose', () => {
    const d = parseDecision('Sure!\n{"sufficient": false, "queries": ["x"]}\nHope that helps.');
    expect(d.sufficient).toBe(false);
    expect(d.queries).toEqual(['x']);
  });

  test('sufficient when the model says so', () => {
    expect(parseDecision('{"sufficient": true, "queries": []}').sufficient).toBe(true);
  });

  test('need-more without queries collapses to sufficient (no empty spin)', () => {
    expect(parseDecision('{"sufficient": false, "queries": []}').sufficient).toBe(true);
  });

  test('unparseable / non-object input stops the loop safely', () => {
    expect(parseDecision('not json at all').sufficient).toBe(true);
    expect(parseDecision('[1,2,3]').sufficient).toBe(true);
    expect(parseDecision('').sufficient).toBe(true);
  });

  test('caps queries at three and drops non-strings/blanks', () => {
    const d = parseDecision('{"sufficient": false, "queries": ["a","b","c","d", 5, "  "]}');
    expect(d.queries).toEqual(['a', 'b', 'c']);
  });
});
