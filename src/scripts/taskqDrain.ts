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
import {
  allBucketStates,
  type BucketState,
  type ClaimFilters,
  finishDrainRun,
  getNeeds,
  insertDrainRun,
  listTasks,
  renderTasksMarkdown,
  scheduleDecision,
  taskqHome,
} from 'cwip/taskq';
import { agentPath, dryRunExecutor, makeClaudeExecutor, probeClaudeCapacity } from '../server/taskq/claudeExecutor';
import { loadTaskqConfig } from '../server/taskq/config';
import { taskqLaunchdPlist } from '../server/taskq/launchd';
import { runDrain } from '../server/taskq/orchestrator';
import { runEpicDecomposition, runTriage } from '../server/taskq/triage';
import { makePlanner, makeTriageAgent } from '../server/taskq/triageAgents';
import { reconcileUsageObservation } from '../server/taskq/usageReconcile';
import { getTaskqDb } from '../server/taskqDb';

function ts(): string {
  const d = new Date();
  return `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;
}

/** Echo any adaptive recalibrations the reconciler made (no-op when nothing moved). */
function logReconcile(actions: ReturnType<typeof reconcileUsageObservation>): void {
  for (const a of actions) process.stdout.write(`  ↻ ${a.key}: ${a.reason}\n`);
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
    process.stdout.write(
      `${ts()} taskq triage: ${t.graded} graded (${t.toReady} ready, ${t.toEpic} epic), ${e.decomposed} decomposed\n`,
    );
  }

  // Per-worker tier filters: flatten fleet tiers into one filter per worker slot.
  const perWorker: ClaimFilters[] = [];
  if (config.fleet?.length) {
    for (const tier of config.fleet) for (let i = 0; i < tier.jobs; i++) perWorker.push({ models: tier.models });
  }
  const maxJobs = perWorker.length || config.jobs;

  // Token-aware scheduling: throttle based on current capacity (never pause — auto-recalibrate on success).
  const buckets = allBucketStates(db, Date.now());
  const wasExhausted: BucketState[] = buckets.filter((b) => b.remaining <= 0);
  const decision = scheduleDecision(buckets, { maxJobs, baseJobs: config.jobs, pauseOnExhausted: false });
  const jobs = Math.min(maxJobs, decision.recommendedJobs);

  const stopFile = join(taskqHome(), '.stop');
  process.stdout.write(
    `${ts()} taskq drain: ${jobs}/${maxJobs} worker(s)${dryRun ? ' [DRY RUN]' : ''} — ${decision.reason}${decision.preferLight ? ' (prefer light)' : ''}, db=${taskqHome()}\n`,
  );

  const drainDecision = decision.preferLight ? 'throttled' : decision.burnExpiring ? 'burning' : 'normal';
  const drainRunId = insertDrainRun(db, {
    startedAt: Date.now(),
    decision: drainDecision,
    reason: decision.reason,
    jobs,
    maxJobs,
  });

  const summary = await runDrain(db, {
    jobs,
    executor,
    leaseTtlMs: config.leaseTtlMs,
    worker: (i) => ({ filters: perWorker[i] ?? {} }),
    shouldStop: () => existsSync(stopFile),
    onEvent: (e) => {
      if (e.type === 'completed') {
        process.stdout.write(`  ✓ #${e.taskId} (${e.durationS}s) by w${e.worker}\n`);
        // A real call went through → we are NOT out of tokens. Adaptively learn:
        // if any bucket was reading exhausted, grow its limit + re-anchor so the
        // estimate stops blocking and tracks reality more closely next time.
        logReconcile(reconcileUsageObservation(db, 'not-exhausted'));
      } else if (e.type === 'failed') {
        process.stdout.write(`  ✗ #${e.taskId}: ${e.reason}\n`);
        // A genuine usage-limit error confirms we ARE out (shrink the estimate so
        // it predicts the wall sooner). Any other failure still proves the call
        // reached the API → treat it as a not-exhausted signal.
        logReconcile(reconcileUsageObservation(db, e.rateLimited ? 'exhausted' : 'not-exhausted'));
      } else if (e.type === 'reaped') process.stdout.write(`  reaped ${e.count} stranded lease(s)\n`);
    },
  });

  // Empty-queue self-heal: nothing ran to give us a signal, yet the estimate
  // says we're out. Fire ONE cheap probe to find out for real, then reconcile —
  // so a stuck "0% remaining" corrects itself without waiting for a task.
  if (!dryRun && wasExhausted.length > 0 && summary.completed + summary.failed === 0) {
    process.stdout.write(`${ts()} estimate read 0% but nothing ran — probing real capacity…\n`);
    const probe = await probeClaudeCapacity();
    if (probe.rateLimited) {
      process.stdout.write(`  · probe confirms usage limit (${probe.detail}) — leaving estimate exhausted\n`);
      logReconcile(reconcileUsageObservation(db, 'exhausted'));
    } else if (probe.ok) {
      logReconcile(reconcileUsageObservation(db, 'not-exhausted'));
    } else {
      process.stdout.write(`  · probe inconclusive (${probe.detail}) — estimate unchanged\n`);
    }
  }

  finishDrainRun(db, drainRunId, {
    endedAt: Date.now(),
    completed: summary.completed,
    failed: summary.failed,
    reaped: summary.reaped,
  });

  regenerateView(db);
  process.stdout.write(
    `${ts()} taskq drain done: ${summary.completed} completed, ${summary.failed} failed, ${summary.reaped} reaped\n`,
  );
}

if (import.meta.main)
  main().catch((e) => {
    process.stderr.write(`taskq drain error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
