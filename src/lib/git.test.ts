import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { gitExcludePatterns } from './git';
import { isIgnored, parseGitignore } from './gitignore';

// The pure parsers (parseBranchTracking, parseRemoteRefs, filterRefs, ...) are
// pinned by cwip's own test suite — only the rubato-side integration of
// gitExcludePatterns with the gitignore engine is tested here, against a real
// temp repo (something cwip's virtualized-fs unit tests can't do).

describe('gitExcludePatterns', () => {
  test('reads core.excludesFile then info/exclude, with info/exclude winning', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'rubato-gitex-'));
    await $`git -C ${repo} init -q`.quiet();
    // Repo-local override keeps the test off the developer's real global config.
    const globalIgnore = join(repo, 'global-ignore');
    await writeFile(globalIgnore, '___*\nfoo.txt\n');
    await $`git -C ${repo} config core.excludesFile ${globalIgnore}`.quiet();
    await writeFile(join(repo, '.git/info/exclude'), 'bar.txt\n!foo.txt\n');

    const layer = { base: '', rules: parseGitignore((await gitExcludePatterns(repo)).join('\n')) };
    expect(isIgnored([layer], '___scratch', true)).toBe(true); // from global excludesFile
    expect(isIgnored([layer], 'bar.txt', false)).toBe(true); // from info/exclude
    expect(isIgnored([layer], 'foo.txt', false)).toBe(false); // info/exclude '!foo.txt' overrides global
  });

  test('does not throw for a non-repo path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-gitex-none-'));
    expect(Array.isArray(await gitExcludePatterns(dir))).toBe(true);
  });
});
