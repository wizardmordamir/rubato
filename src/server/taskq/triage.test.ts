import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { addTask, getClarification, getTask, listChildren, listTasks, migrate, openClarifications, type TaskqDb } from 'cwip/taskq';
import { type Planner, resolveGateway, runEpicDecomposition, runTriage, type TriageAgent } from './triage';

function fresh(): TaskqDb {
  const d = new Database(':memory:') as unknown as TaskqDb;
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

const agent: TriageAgent = async (t) =>
  t.title.startsWith('EPIC') ? { complexity: 'epic' } : { model: 'sonnet', think: 'low', complexity: 'single' };

const planner: Planner = async () => ({
  children: [{ title: 'step 1' }, { title: 'step 2', body: 'do step 2' }],
  question: 'Which framework?',
});

describe('runTriage', () => {
  test('grades single → ready with model/think; epic stays pending', async () => {
    const db = fresh();
    addTask(db, { title: 'mechanical chore', status: 'pending_triage' });
    addTask(db, { title: 'EPIC big build', status: 'pending_triage' });
    const s = await runTriage(db, agent);
    expect(s.graded).toBe(2);
    expect(s.toReady).toBe(1);
    expect(s.toEpic).toBe(1);

    const single = listTasks(db, { status: 'ready' })[0];
    expect(single.model).toBe('sonnet');
    expect(single.think).toBe('low');
    const epic = listTasks(db, { status: 'pending_triage' })[0];
    expect(epic.complexity).toBe('epic');
  });
});

describe('runEpicDecomposition + resolveGateway', () => {
  test('epic → children (not_ready) + a needs_input gateway; answering releases them', async () => {
    const db = fresh();
    const epicId = addTask(db, { title: 'EPIC build a game', status: 'pending_triage' });
    db.run(`UPDATE tasks SET complexity = 'epic' WHERE id = ?`, epicId);

    const es = await runEpicDecomposition(db, planner);
    expect(es.decomposed).toBe(1);
    expect(es.childrenCreated).toBe(2);
    expect(getTask(db, epicId)?.status).toBe('needs_input');
    expect(listChildren(db, epicId).every((c) => c.status === 'not_ready')).toBe(true);

    const open = openClarifications(db);
    expect(open.length).toBe(1);
    expect(open[0].question).toBe('Which framework?');

    resolveGateway(db, epicId, 'three.js');
    expect(getTask(db, epicId)?.status).toBe('done');
    expect(getClarification(db, epicId)?.answer).toBe('three.js');
    const kids = listChildren(db, epicId);
    expect(kids.every((c) => c.status === 'ready')).toBe(true);
    expect(kids[0].body).toContain('three.js'); // answer carried into the child
  });
});
