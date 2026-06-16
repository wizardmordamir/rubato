import { expect, test } from 'bun:test';
import { normalizeUrl } from './url';

test('adds https:// to a schemeless host', () => {
  expect(normalizeUrl('example.com')).toBe('https://example.com');
  expect(normalizeUrl('cursedalchemy.com/login')).toBe('https://cursedalchemy.com/login');
  expect(normalizeUrl('  example.com  ')).toBe('https://example.com');
});

test('leaves an explicit scheme untouched', () => {
  expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  expect(normalizeUrl('https://example.com/x')).toBe('https://example.com/x');
  expect(normalizeUrl('about:blank')).toBe('about:blank');
  expect(normalizeUrl('data:text/html,<h1>hi</h1>')).toBe('data:text/html,<h1>hi</h1>');
  expect(normalizeUrl('file:///tmp/x.html')).toBe('file:///tmp/x.html');
});

test('uses http for loopback dev servers', () => {
  expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
  expect(normalizeUrl('localhost:5173/automations')).toBe('http://localhost:5173/automations');
  expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
});

test("does not mistake a domain that starts with 'localhost' for loopback", () => {
  expect(normalizeUrl('localhosting.com')).toBe('https://localhosting.com');
});

test('empty stays empty', () => {
  expect(normalizeUrl('')).toBe('');
  expect(normalizeUrl('   ')).toBe('');
});
