import { describe, expect, test } from 'bun:test';
import type { CurlRequestInput } from '../shared/tools/curl';
import {
  createConversation,
  deleteConversation,
  deleteSavedCurlRequest,
  deleteSavedRegex,
  getConversation,
  listSavedCurlRequests,
  listSavedRegexes,
  saveCurlRequest,
  saveRegex,
} from './db';

const sampleRequest: CurlRequestInput = {
  method: 'POST',
  url: 'https://api.example.com/x',
  queryParams: [],
  headers: [{ key: 'X-Trace', value: '1', enabled: true }],
  body: '{"a":1}',
  bodyType: 'json',
  auth: { type: 'bearer', token: 'tok' },
  flags: ['-L'],
};

describe('saved curl requests', () => {
  test('create → list → update → delete round-trip', () => {
    const created = saveCurlRequest({ name: 'db-test curl', request: sampleRequest });
    expect(created.id).toBeTruthy();
    expect(created.request.headers[0].value).toBe('1');

    try {
      expect(listSavedCurlRequests().some((r) => r.id === created.id)).toBe(true);

      const updated = saveCurlRequest({ id: created.id, name: 'db-test curl 2', request: sampleRequest });
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('db-test curl 2');
      expect(listSavedCurlRequests().find((r) => r.id === created.id)?.name).toBe('db-test curl 2');
    } finally {
      expect(deleteSavedCurlRequest(created.id)).toBe(true);
    }
    expect(listSavedCurlRequests().some((r) => r.id === created.id)).toBe(false);
    expect(deleteSavedCurlRequest(created.id)).toBe(false);
  });
});

describe('saved regexes', () => {
  test('create → list → delete round-trip; notes default to empty', () => {
    const created = saveRegex({ title: 'db-test re', pattern: '\\d+', flags: 'g' });
    expect(created.id).toBeTruthy();
    expect(created.notes).toBe('');

    try {
      const found = listSavedRegexes().find((r) => r.id === created.id);
      expect(found?.pattern).toBe('\\d+');
      expect(found?.flags).toBe('g');
    } finally {
      expect(deleteSavedRegex(created.id)).toBe(true);
    }
    expect(listSavedRegexes().some((r) => r.id === created.id)).toBe(false);
  });
});

describe('conversations: persisted fsRoot', () => {
  test('general conversation round-trips its folder; app conversation has none', () => {
    const general = createConversation(undefined, '/tmp/some-folder');
    const scoped = createConversation('my-app');
    try {
      expect(general.fsRoot).toBe('/tmp/some-folder');
      expect(getConversation(general.id)?.fsRoot).toBe('/tmp/some-folder');
      expect(getConversation(general.id)?.app).toBeUndefined();
      expect(getConversation(scoped.id)?.fsRoot).toBeUndefined();
      expect(getConversation(scoped.id)?.app).toBe('my-app');
    } finally {
      deleteConversation(general.id);
      deleteConversation(scoped.id);
    }
  });
});
