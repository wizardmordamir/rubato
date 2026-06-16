import { describe, expect, test } from 'bun:test';
import { fillTemplate, redactSecrets } from './toolTemplate';

describe('fillTemplate', () => {
  const scope: Record<string, string> = { id: '42', 'api.gitlab.baseUrl': 'https://gl.example', 'env.TOK': 's3cr3t' };
  const resolve = (k: string) => scope[k];

  test('substitutes known keys', () => {
    expect(fillTemplate('${api.gitlab.baseUrl}/projects/${id}', resolve)).toBe('https://gl.example/projects/42');
  });

  test('unknown keys become empty', () => {
    expect(fillTemplate('a${missing}b', resolve)).toBe('ab');
  });

  test('leaves non-template text untouched', () => {
    expect(fillTemplate('plain text', resolve)).toBe('plain text');
  });
});

describe('redactSecrets', () => {
  test('masks every occurrence of each secret', () => {
    expect(redactSecrets('token=s3cr3t and again s3cr3t', ['s3cr3t'])).toBe('token=*** and again ***');
  });
  test('ignores empty secrets', () => {
    expect(redactSecrets('unchanged', ['', undefined as unknown as string].filter(Boolean))).toBe('unchanged');
  });
});
