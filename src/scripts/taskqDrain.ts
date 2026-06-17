#!/usr/bin/env bun
/**
 * taskq drainer entrypoint (the v2 orchestrator process; replaces drain-queue.sh).
 * Opens ~/.taskq, sizes the worker pool from config (flat JOBS or fleet tiers),
 * picks the real `claude -p` executor (or a no-op in dry-run), drains until the
 * queue is empty or a stop sentinel appears, then regenerates the markdown view.
 *
 *   bun run src/scripts/taskqDrain.ts            # real run
 *   TASKQ_DRY_RUN=1 bun run src/scripts/taskqDrain.ts   # validate the loop, no agents
 *
 * Graceful stop: `touch ~/.taskq/.stop` (workers exit between tasks).
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allBucketStates, type ClaimFilters, finishDrainRun, getNeeds, insertDrainRun, listTasks, renderTasksMarkdown, scheduleDecision, taskqHome } from 'cwip/taskq';
import { getTaskqDb } from '../server/taskqDb';
import { loadTaskqConfig } from '../server/taskq/config';
import { agentPath, dryRunExecutor, makeClaudeExecutor } from '../server/taskq/claudeExecutor';
import { taskqLaunchdPlist } from '../server/taskq/launchd';
import { runDrain } from '../server/taskq/orchestrator';
import { runEpicDecomposition, runTriage } from '../server/taskq/triage';
import { makePlanner, makeTriageAgent } from '../server/taskq/triageAgents';

function ts(): string {
  const d = new Date();
  return `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;
}

function regenerateView(db: ReturnType<typeof getTaskqDb>): void {
  const rows = listTasks(db);
  const needs: Record<number, string[]> = {};
  for (const t of rows) {
    const n = getNeeds(db, t.id);
    if (n.length) needs[t.id] = n;
  }
  writeFileSync(join(taskqHome(), 'TASKS.view.md'), renderTasksMarkdown(rows, needs));
}

async function main(): Promise<void> {
  if (process.argv.includes('--print-launchd')) {
    process.stdout.write(
      taskqLaunchdPlist({
        bunPath: process.execPath,
        rubatoDir: process.cwd(),
        intervalSeconds: 300,
        logDir: taskqHome(),
        path: agentPath(),
      }),
    );
    return;
  }

  // Stamp the fire time so the UI can compute a real countdown to the next tick.
  writeFileSync(join(taskqHome(), '.last-fire'), String(Date.now()));

  const config = loadTaskqConfig();
  const db = getTaskqDb();
  const dryRun = process.env.TASKQ_DRY_RUN === '1';
  const executor = dryRun ? dryRunExecutor : makeClaudeExecutor(config);

  // Opt-in: grade blank tasks + decompose epics before draining.
  if (config.triage?.enabled && !dryRun) {
    const t = await runTriage(db, makeTriageAgent());
    const e = await runEpicDecomposition(db, makePlanner());
    process.stdout.write(`${ts()} taskq triage: ${t.graded} graded (${t.toReady} ready, ${t.toEpic} epic), ${e.decomposed} decomposed\n`);
  }

  // Per-worker tier filters: flatten fleet tiers into one filter per worker slot.
  const perWorker: ClaimFilters[] = [];
  if (config.fleet?.length) {
    for (const tier of config.fleet) for (let i = 0; i < tier.jobs; i++) perWorker.push({ models: tier.models });
  }
  const maxJobs = perWorker.length || config.jobs;

  // Token-aware scheduling: throttle/pause based on current capacity.
  const decision = scheduleDecision(allBucketStates(db, Date.now()), { maxJobs, baseJobs: config.jobs });
  if (decision.paused) {
    process.stdout.write(`${ts()} taskq drain: PAUSED — ${decision.reason}\n`);
    const pausedRunId = insertDrainRun(db, { startedAt: Date.now(), decision: 'paused', reason: decision.reason, jobs: 0, maxJobs });
    finishDrainRun(db, pausedRunId, { endedAt: Date.now(), completed: 0, failed: 0, reaped: 0 });
    return;
  }
  const jobs = Math.min(maxJobs, decision.recommendedJobs);

  const stopFile = join(taskqHome(), '.stop');
  process.stdout.write(
    `${ts()} taskq drain: ${jobs}/${maxJobs} worker(s)${dryRun ? ' [DRY RUN]' : ''} — ${decision.reason}${decision.preferLight ? ' (prefer light)' : ''}, db=${taskqHome()}\n`,
  );

  const drainDecision = decision.preferLight ? 'throttled' : decision.burnExpiring ? 'burning' : 'normal';
  const drainRunId = insertDrainRun(db, { startedAt: Date.now(), decision: drainDecision, reason: decision.reason, jobs, maxJobs });

  const summary = await runDrain(db, {
    jobs,
    executor,
    leaseTtlMs: config.leaseTtlMs,
    worker: (i) => ({ filters: perWorker[i] ?? {} }),
    shouldStop: () => existsSync(stopFile),
    onEvent: (e) => {
      if (e.type === 'completed') process.stdout.write(`  ✓ #${e.taskId} (${e.durationS}s) by w${e.worker}\n`);
      else if (e.type === 'failed') process.stdout.write(`  ✗ #${e.taskId}: ${e.reason}\n`);
      else if (e.type === 'reaped') process.stdout.write(`  reaped ${e.count} stranded lease(s)\n`);
    },
  });

  finishDrainRun(db, drainRunId, { endedAt: Date.now(), completed: summary.completed, failed: summary.failed, reaped: summary.reaped });

  regenerateView(db);
  process.stdout.write(`${ts()} taskq drain done: ${summary.completed} completed, ${summary.failed} failed, ${summary.reaped} reaped\n`);
}

main().catch((e) => {
  process.stderr.write(`taskq drain error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
