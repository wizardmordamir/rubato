import { describe, expect, test } from 'bun:test';
import { parseDeployList, parseImageShaList } from './parseList';

describe('parseDeployList', () => {
  test('parses the block layout (commit + sha256)', () => {
    const text = [
      'team/my-app 1.1.13.739',
      'commit a1c32a4414fea408b4e9472ddb45969a66100c38',
      'sha256:617b85b647c550db2a54f167fc98cb406bdb69c42f795bcc708c92f28e3e5ae9',
      '',
      'team/my-api 1.1.9.571',
      'commit aa44ffc895ec4e1c30c4ec794ebf3c6199658d78',
      'sha256:f105f0847eb7d7a924fba6f42be7720ad8d1976281e4fbf1fe5b20b3780a82be',
    ].join('\n');
    const { entries, problems } = parseDeployList(text);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      app: 'team/my-app',
      version: '1.1.13.739',
      commit: 'a1c32a4414fea408b4e9472ddb45969a66100c38',
      sha256: '617b85b647c550db2a54f167fc98cb406bdb69c42f795bcc708c92f28e3e5ae9',
      date: undefined,
      sourceLine: 1,
    });
    expect(entries[1].sourceLine).toBe(5);
  });

  test('parses the dated layout (commit: colon + date)', () => {
    const text = [
      'team/my-consumer 1.1.1.536 (6-9 7:49)',
      'commit: e4f42275f3902dfe70f454a8d0697b7c499c016b',
      'sha256:81c349c89c98377e35a4bb4e7261b90e963fb72a1db4ded2cdce9622a3048c59',
    ].join('\n');
    const { entries, problems } = parseDeployList(text);
    expect(problems).toEqual([]);
    expect(entries[0].date).toBe('6-9 7:49');
    expect(entries[0].commit).toBe('e4f42275f3902dfe70f454a8d0697b7c499c016b');
  });

  test('parses the single-line image layout (no commit)', () => {
    const text = 'team/my-monitor 1.6.3.701 sha256:66de3b80aa4b6bc019cd434d7d99883f32c38faf771000afe151f0206f2c5cc9';
    const { entries } = parseDeployList(text);
    expect(entries[0].app).toBe('team/my-monitor');
    expect(entries[0].version).toBe('1.6.3.701');
    expect(entries[0].commit).toBeUndefined();
    expect(entries[0].sha256).toBe('66de3b80aa4b6bc019cd434d7d99883f32c38faf771000afe151f0206f2c5cc9');
  });

  test('normalizes sha/commit to lowercase and ignores comments/blank lines', () => {
    const text = ['# a comment', '', 'org/app 1.0.0', 'COMMIT ABCDEF1234567890', `SHA256:${'A'.repeat(64)}`].join('\n');
    const { entries } = parseDeployList(text);
    expect(entries[0].commit).toBe('abcdef1234567890');
    expect(entries[0].sha256).toBe('a'.repeat(64));
  });

  test('reports an entry missing its sha256 as a problem', () => {
    const { entries, problems } = parseDeployList('org/app 1.0.0\ncommit abc1234');
    expect(entries).toHaveLength(0);
    expect(problems[0].message).toContain('no sha256');
  });

  test('reports an orphan sha256 line', () => {
    const { problems } = parseDeployList(`sha256:${'b'.repeat(64)}`);
    expect(problems[0].message).toContain('no preceding');
  });
});

describe('parseImageShaList', () => {
  test('extracts digest with optional app/version', () => {
    const text = [`team/my-monitor 1.6.3.701 sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`].join('\n');
    const { entries, problems } = parseImageShaList(text);
    expect(problems).toEqual([]);
    expect(entries[0]).toMatchObject({ app: 'team/my-monitor', version: '1.6.3.701', sha256: 'a'.repeat(64) });
    expect(entries[1]).toMatchObject({ app: undefined, version: undefined, sha256: 'b'.repeat(64) });
  });

  test('flags a line with no digest', () => {
    const { problems } = parseImageShaList('just some text');
    expect(problems[0].message).toContain('no sha256');
  });
});
