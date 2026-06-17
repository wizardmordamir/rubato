import { describe, expect, test } from 'bun:test';
import {
  deriveTaskTitle,
  draftFromTask,
  effectiveTaskTitle,
  serializeTaskBlock,
  serializeTaskMarkers,
  type TaskDraft,
  validateTaskDraft,
} from '../../shared/orchestration';
import { deleteTaskBlock, insertTaskBlock, replaceTaskBlock, TaskConflictError } from './editTasks';
import { parseTaskBoard } from './parseTasks';

const SAMPLE = `<!-- Pure task list. -->

## [ ] First task
First body line.

<!-- ======= SECTION BANNER ======= -->

## [b] (model:opus) (think:high) (id:second) Second task
Second body.

## [-] (needs:second) Third task
`;

describe('validateTaskDraft', () => {
  test('accepts a minimal ready task', () => {
    expect(validateTaskDraft({ status: 'ready', title: 'Do a thing' })).toEqual([]);
  });

  test('requires a non-empty single-line title', () => {
    expect(validateTaskDraft({ status: 'ready', title: '' })).toContain(
      'add a title or some detail lines to derive one from',
    );
    expect(validateTaskDraft({ status: 'ready', title: 'a\nb' })).toContain('title must be a single line');
  });

  test('accepts a blank title when the body can supply one', () => {
    expect(validateTaskDraft({ status: 'ready', title: '', body: 'Fix the thing' })).toEqual([]);
  });

  test('rejects bad markers', () => {
    const errs = validateTaskDraft({
      status: 'ready',
      title: 't',
      model: 'gpt',
      thinkingLevel: 'huge' as TaskDraft['thinkingLevel'],
      id: 'bad id',
      group: 'bad/group',
      needs: ['ok', 'not ok'],
      recur: 0,
    });
    expect(errs.length).toBeGreaterThanOrEqual(5);
  });

  test('rejects self-dependency', () => {
    expect(validateTaskDraft({ status: 'ready', title: 't', id: 'x', needs: ['x'] })).toContain(
      'a task cannot depend on its own id',
    );
  });
});

describe('serialize', () => {
  test('markers come out in canonical order', () => {
    const draft: TaskDraft = {
      status: 'ready',
      title: 'T',
      model: 'sonnet',
      thinkingLevel: 'low',
      id: 'a',
      needs: ['b', 'c'],
      group: 'g',
      recur: 10,
      recurLast: 3,
    };
    expect(serializeTaskMarkers(draft)).toBe(
      '(recur:10 last:3) (id:a) (needs:b,c) (group:g) (model:sonnet) (think:low)',
    );
  });

  test('full block: heading tag + markers + body', () => {
    const block = serializeTaskBlock({ status: 'hold', title: 'Hold me', body: 'line one\nline two' });
    expect(block).toBe('## [b] Hold me\nline one\nline two');
  });

  test('not-ready maps to [-] and omits empty markers', () => {
    expect(serializeTaskBlock({ status: 'not-ready', title: 'X' })).toBe('## [-] X');
  });

  test('throws on an invalid draft', () => {
    expect(() => serializeTaskBlock({ status: 'ready', title: '' })).toThrow(/invalid task draft/);
  });

  test('derives the heading title from the first line of the body when title is blank', () => {
    const block = serializeTaskBlock({ status: 'ready', title: '', body: 'Add a meter\nmore detail here' });
    expect(block).toBe('## [ ] Add a meter\nAdd a meter\nmore detail here');
  });

  test('an explicit title overrides the derived one', () => {
    const block = serializeTaskBlock({ status: 'ready', title: 'Real title', body: 'first line of detail' });
    expect(block).toBe('## [ ] Real title\nfirst line of detail');
  });
});

describe('deriveTaskTitle / effectiveTaskTitle', () => {
  test('uses the first non-empty line, skipping leading blanks', () => {
    expect(deriveTaskTitle('\n\n  First real line  \nsecond')).toBe('First real line');
  });

  test('clips a run-on first line to its first sentence', () => {
    expect(deriveTaskTitle('Do the first thing. Then the second thing happens.')).toBe('Do the first thing.');
  });

  test('passes a short terminator-less line through whole', () => {
    expect(deriveTaskTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  test('returns empty for blank/undefined bodies', () => {
    expect(deriveTaskTitle('')).toBe('');
    expect(deriveTaskTitle(undefined)).toBe('');
    expect(deriveTaskTitle('   \n  ')).toBe('');
  });

  test('effectiveTaskTitle prefers an explicit title, else derives', () => {
    expect(effectiveTaskTitle({ status: 'ready', title: 'Explicit', body: 'derived line' })).toBe('Explicit');
    expect(effectiveTaskTitle({ status: 'ready', title: '   ', body: 'derived line' })).toBe('derived line');
    expect(effectiveTaskTitle({ status: 'ready', title: '' })).toBe('');
  });
});

describe('draftFromTask round-trips through the parser', () => {
  test('parse → draft → serialize is stable', () => {
    const board = parseTaskBoard(SAMPLE);
    const second = board.tasks.find((t) => t.meta.id === 'second');
    expect(second).toBeDefined();
    const draft = draftFromTask(second!);
    expect(draft.status).toBe('hold');
    expect(draft.model).toBe('opus');
    expect(draft.thinkingLevel).toBe('high');
    expect(draft.id).toBe('second');
    const block = serializeTaskBlock(draft);
    expect(block).toContain('## [b]');
    expect(block).toContain('(model:opus)');
    expect(block).toContain('(id:second)');
  });

  test('needs markers parse into an array', () => {
    const board = parseTaskBoard(SAMPLE);
    const third = board.tasks.find((t) => t.title === 'Third task');
    expect(third?.meta.needs).toEqual(['second']);
    expect(third?.status).toBe('not-ready');
  });
});

describe('insertTaskBlock', () => {
  const block = '## [ ] Inserted task';

  test('top inserts above the first task, below the legend', () => {
    const out = insertTaskBlock(SAMPLE, block, 'top');
    const board = parseTaskBoard(out);
    expect(board.tasks[0].title).toBe('Inserted task');
    // The legend comment survives.
    expect(out).toContain('<!-- Pure task list. -->');
    // The section banner survives too.
    expect(out).toContain('SECTION BANNER');
  });

  test('bottom appends after the last task', () => {
    const out = insertTaskBlock(SAMPLE, block, 'bottom');
    const board = parseTaskBoard(out);
    expect(board.tasks[board.tasks.length - 1].title).toBe('Inserted task');
  });

  test('before/after position relative to an anchor', () => {
    const anchor = '## [b] (model:opus) (think:high) (id:second) Second task';
    const before = parseTaskBoard(insertTaskBlock(SAMPLE, block, 'before', anchor)).tasks.map((t) => t.title);
    expect(before.indexOf('Inserted task')).toBe(before.indexOf('Second task') - 1);

    const after = parseTaskBoard(insertTaskBlock(SAMPLE, block, 'after', anchor)).tasks.map((t) => t.title);
    expect(after.indexOf('Inserted task')).toBe(after.indexOf('Second task') + 1);
  });

  test('after the first task does not swallow the following banner', () => {
    const out = insertTaskBlock(SAMPLE, block, 'after', '## [ ] First task');
    expect(out).toContain('SECTION BANNER');
    const board = parseTaskBoard(out);
    expect(board.tasks.find((t) => t.title === 'First task')?.body).toBe('First body line.');
  });

  test('a missing anchor throws a conflict', () => {
    expect(() => insertTaskBlock(SAMPLE, block, 'after', '## [ ] Ghost')).toThrow(TaskConflictError);
  });

  test('preserves the trailing newline', () => {
    expect(insertTaskBlock(SAMPLE, block, 'bottom').endsWith('\n')).toBe(true);
    expect(insertTaskBlock('## [ ] only', block, 'bottom').endsWith('\n')).toBe(false);
  });
});

describe('replaceTaskBlock', () => {
  test('replaces only the targeted task, preserving neighbours + banner', () => {
    const anchor = '## [ ] First task';
    const out = replaceTaskBlock(SAMPLE, anchor, '## [b] First task (held)\nNew body.');
    const board = parseTaskBoard(out);
    expect(board.tasks[0].title).toBe('First task (held)');
    expect(board.tasks[0].status).toBe('blocked');
    expect(board.tasks.find((t) => t.meta.id === 'second')).toBeDefined();
    expect(out).toContain('SECTION BANNER');
  });

  test('a missing anchor throws a conflict', () => {
    expect(() => replaceTaskBlock(SAMPLE, '## [~] claimed by worker', '## [ ] x')).toThrow(TaskConflictError);
  });
});

describe('deleteTaskBlock', () => {
  test('removes the task and its body, keeps the rest', () => {
    const out = deleteTaskBlock(SAMPLE, '## [ ] First task');
    const board = parseTaskBoard(out);
    expect(board.tasks.find((t) => t.title === 'First task')).toBeUndefined();
    expect(board.tasks.length).toBe(2);
    expect(out).toContain('SECTION BANNER');
    // No tripled blank lines left behind.
    expect(out).not.toMatch(/\n\n\n\n/);
  });

  test('a missing anchor throws a conflict', () => {
    expect(() => deleteTaskBlock(SAMPLE, '## [ ] Ghost')).toThrow(TaskConflictError);
  });
});
