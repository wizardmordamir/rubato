import { describe, expect, test } from 'bun:test';
import { COMMANDS } from '../commands';
import { renderCommandsByExample } from './commandsDoc';

describe('renderCommandsByExample', () => {
  test('renders a heading and usage block for every registered command', () => {
    const md = renderCommandsByExample();
    for (const c of COMMANDS) {
      expect(md).toContain(`## \`${c.name}`);
    }
    expect(md).toContain('# Commands by example');
    expect((md.match(/```sh/g) ?? []).length).toBe(COMMANDS.length); // one usage block each
  });

  test('renders args, flags, and examples for a synthetic command', () => {
    const md = renderCommandsByExample([
      {
        name: 'demo',
        script: 'x.ts',
        kind: 'plain',
        description: 'A demo command.',
        args: [{ name: 'target', description: 'what to act on', required: true }],
        flags: [{ flag: '--dry-run', description: 'preview only' }],
        examples: [{ args: 'foo --dry-run', note: 'preview foo' }],
      },
    ]);
    expect(md).toContain('## `demo <target>`');
    expect(md).toContain('- `target` — what to act on');
    expect(md).toContain('- `--dry-run` — preview only');
    expect(md).toContain('demo foo --dry-run    # preview foo');
  });

  test('optional args render in brackets; takesValue flags show a placeholder', () => {
    const md = renderCommandsByExample([
      {
        name: 'demo',
        script: 'x.ts',
        kind: 'plain',
        description: 'd',
        args: [{ name: 'path', description: 'p' }],
        flags: [{ flag: '--out', description: 'o', takesValue: true, example: 'file.txt' }],
      },
    ]);
    expect(md).toContain('## `demo [path]`');
    expect(md).toContain('- `--out <file.txt>` —');
  });
});
