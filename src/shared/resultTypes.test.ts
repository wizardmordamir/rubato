import { describe, expect, test } from 'bun:test';
import { dataToTypeScript, toTypeName } from './resultTypes';

describe('toTypeName', () => {
  test('pascal-cases a snake/kebab/spaced label', () => {
    expect(toTypeName('user_accounts')).toBe('UserAccounts');
    expect(toTypeName('deploy-verifications')).toBe('DeployVerifications');
    expect(toTypeName('my table name')).toBe('MyTableName');
  });
  test('prefixes when it would start with a digit, and falls back when empty', () => {
    expect(toTypeName('123stats')).toBe('T123stats');
    expect(toTypeName('')).toBe('Result');
    expect(toTypeName(undefined, 'Row')).toBe('Row');
  });
});

describe('dataToTypeScript', () => {
  test('infers a row interface from an array of rows (mixed keys → optional)', () => {
    const ts = dataToTypeScript(
      [
        { id: 1, name: 'a', active: true },
        { id: 2, name: 'b' }, // missing `active`
      ],
      'users',
    );
    expect(ts).toContain('export interface Users {');
    expect(ts).toContain('id: number;');
    expect(ts).toContain('name: string;');
    expect(ts).toContain('active?: boolean;'); // present in only one row → optional
  });

  test('infers an interface from a single object', () => {
    const ts = dataToTypeScript({ host: 'x', port: 5432, tags: ['a', 'b'] }, 'conn');
    expect(ts).toContain('export interface Conn {');
    expect(ts).toContain('port: number;');
    expect(ts).toContain('tags: string[];');
  });

  test('quotes non-identifier keys', () => {
    const ts = dataToTypeScript([{ 'weird key': 1 }], 'row');
    expect(ts).toContain('"weird key": number;');
  });

  test('emits a placeholder for an empty array', () => {
    const ts = dataToTypeScript([], 'empty');
    expect(ts).toContain('No rows to infer from');
    expect(ts).toContain('export type Empty = unknown;');
  });

  test('emits a placeholder for null/undefined', () => {
    expect(dataToTypeScript(null, 'x')).toContain('No data to infer from');
    expect(dataToTypeScript(undefined)).toContain('export type Result = unknown;');
  });
});
