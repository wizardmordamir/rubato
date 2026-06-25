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
  autoTierEligibleAsync,
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
import { currentInterval } from '../server/taskq/control';
import { makeDoneGuard } from '../server/taskq/doneCheck';
import { taskqLaunchdPlist } from '../server/taskq/launchd';
import { runDrain } from '../server/taskq/orchestrator';
import { makeLlmTierClassifier } from '../server/taskq/tierClassifier';
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

/**
 * Connectivity preflight. The `claude -p` workers (and the triage / tier-sweep LLM
 * calls) all depend on api.anthropic.com. During a network outage each worker exits 1
 * instantly, and the drain would re-claim + re-run the task until it burns its whole
 * retry budget (→ terminal `failed`) for a failure that has nothing to do with the task
 * — exactly what stranded nova-c0 the first time. So we confirm the API host is
 * reachable before claiming anything. A HEAD that gets ANY HTTP response (even a 401)
 * proves the DNS/TLS/network path is up; only a network-level failure (DNS, connection
 * refused, timeout) counts as offline. Injectable for tests.
 */
export async function isApiReachable(timeoutMs = 5000, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetcher('https://api.anthropic.com/v1/models', {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Last-resort safety valve against an unforeseen wedge. The per-task timeout
 * (claudeExecutor) already bounds any single hung agent and the loop terminates
 * when the queue drains — but if the process ever got stuck for some reason we
 * HAVEN'T fixed, launchd could never relaunch it (it can't re-fire while this
 * one is alive). So force-exit after a hard ceiling: launchd's next tick starts
 * a clean pass, and any in-flight lease is reaped by that pass. Generous by
 * default (8h, well past any healthy drain) and tunable via TASKQ_MAX_RUNTIME_MS
 * (0 disables). `unref()` so the timer itself never keeps the process alive.
 */
function installRuntimeBackstop(): void {
  const envRaw = process.env.TASKQ_MAX_RUNTIME_MS;
  const parsed = envRaw != null ? Number(envRaw) : NaN;
  const maxMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 8 * 60 * 60_000;
  if (maxMs <= 0) return;
  const guard = setTimeout(() => {
    process.stderr.write(
      `${ts()} taskq drain exceeded max runtime ${Math.round(maxMs / 60_000)}m — force-exiting so launchd can relaunch\n`,
    );
    process.exit(0); // clean exit; StartInterval re-fires, the reaper reclaims any in-flight lease
  }, maxMs);
  guard.unref?.();
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

  installRuntimeBackstop();

  const config = loadTaskqConfig();
  const db = getTaskqDb();
  const dryRun = process.env.TASKQ_DRY_RUN === '1';

  // Connectivity gate: if the API host the workers need is unreachable (a network
  // outage), skip this ENTIRE tick — claim nothing, spawn no workers, burn no retries.
  // `.last-fire` was already stamped above, so the drain still reads as alive; launchd
  // re-fires on the interval and the run resumes the moment the network is back. Without
  // this, an outage drives every in-flight task through its full retry budget to a
  // terminal `failed` (which is what stranded nova-c0). Dry-run makes no API calls, so
  // it skips the check.
  if (!dryRun && !(await isApiReachable())) {
    process.stdout.write(
      `${ts()} taskq drain: OFFLINE — api.anthropic.com unreachable; skipping tick (no claim, no retries burned)\n`,
    );
    return;
  }

  const executor = dryRun ? dryRunExecutor : makeClaudeExecutor(config);
  // False-done gate: before a reported success is marked done, require it landed
  // code on refactor/integration + didn't regress the build (see doneCheck.ts).
  // Skipped in dry-run (the no-op executor lands nothing, so every "done" would —
  // correctly — read as empty; there's nothing real to verify there).
  const verifyDone = dryRun ? undefined : makeDoneGuard(config);

  // Opt-in: grade blank tasks + decompose epics before draining.
  if (config.triage?.enabled && !dryRun) {
    const t = await runTriage(db, makeTriageAgent());
    const e = await runEpicDecomposition(db, makePlanner());
    process.stdout.write(
      `${ts()} taskq triage: ${t.graded} graded (${t.toReady} ready, ${t.toEpic} epic), ${e.decomposed} decomposed\n`,
    );
  }

  // Opt-in LLM tier pre-sweep: refine AMBIGUOUS tasks (no heuristic keyword signal)
  // with one cheap Haiku call before workers claim them. Skipped in dry-run and when
  // ANTHROPIC_API_KEY is absent (makeLlmTierClassifier returns null in both cases).
  if (!dryRun) {
    const classifier = makeLlmTierClassifier();
    if (classifier) {
      const preSwept = await autoTierEligibleAsync(db, Date.now(), { classify: classifier });
      if (preSwept > 0) {
        process.stdout.write(`${ts()} taskq tier pre-sweep: ${preSwept} task(s) LLM-refined\n`);
      }
    }
  }

  const stopFile = join(taskqHome(), '.stop');
  const lastFireFile = join(taskqHome(), '.last-fire');

  // Recompute the drain plan (per-worker tier filters + job count) from the
  // CURRENT config + token buckets. Called live on every supervisor tick so a
  // mid-run change — the user bumps JOBS, edits fleet tiers, toggles throttle, or
  // capacity frees up — takes effect WITHOUT restarting the drain.
  //
  // MAXIMIZE by default (cfg.throttle=false): run the full jobs/fleet pool, no
  // adaptive shrink — a lockout rejects calls without charging, so the full pool
  // costs nothing extra and the per-task limit-backoff (not a shrinking pool)
  // absorbs limits. With throttle on, the usage estimator reduces the pool toward
  // the schedule's recommendation as limits approach.
  const planDrain = () => {
    const cfg = loadTaskqConfig();
    const perWorker: ClaimFilters[] = [];
    if (cfg.fleet?.length) {
      for (const tier of cfg.fleet) for (let i = 0; i < tier.jobs; i++) perWorker.push({ models: tier.models });
    }
    const maxJobs = perWorker.length || cfg.jobs;
    const decision = scheduleDecision(allBucketStates(db, Date.now()), {
      maxJobs,
      baseJobs: cfg.jobs,
      pauseOnExhausted: false,
    });
    // EMERGENCY exclusivity: when an `emergency-*` task is open (a broken-main heal,
    // filed by the localhost watchdog), collapse the pool to a SINGLE worker. With the
    // emergency pinned to the top of the board it's claimed first, so the one worker
    // fixes main BEFORE starting anything else — no fleet of workers piling on while
    // localhost is down. Normal pool resumes the cycle after it clears.
    const emergencyOpen = listTasks(db).some(
      (t) => (t.slug?.startsWith('emergency-') ?? false) && (t.status === 'ready' || t.status === 'claimed'),
    );
    const jobs = emergencyOpen ? 1 : cfg.throttle ? Math.min(maxJobs, decision.recommendedJobs) : maxJobs;
    return { perWorker, maxJobs, decision, jobs, throttle: cfg.throttle, emergencyOpen };
  };

  // Capacity snapshot for the empty-queue self-heal probe (start of run only).
  const wasExhausted: BucketState[] = allBucketStates(db, Date.now()).filter((b) => b.remaining <= 0);

  const plan0 = planDrain();
  // When throttle is off (MAXIMIZE) the pool isn't shrunk, so don't advertise a
  // "prefer light" throttle even if capacity is scarce — the full pool is running.
  const throttledNow = plan0.throttle && plan0.decision.preferLight;
  // Mirror the capacity panel: in maximize mode the scheduleDecision's throttle
  // recommendation is NOT applied, so report the full pool that actually runs rather
  // than the raw "throttle to 1 worker + light models" estimate (the Watchdog drain
  // history reads this `reason`).
  const reason =
    !plan0.throttle && plan0.decision.preferLight
      ? `maximize — running all ${plan0.maxJobs} workers at configured models (estimate: ${plan0.decision.reason})`
      : plan0.decision.reason;
  process.stdout.write(
    `${ts()} taskq drain: ${plan0.jobs}/${plan0.maxJobs} worker(s)${dryRun ? ' [DRY RUN]' : ''} — ${reason}${throttledNow ? ' (prefer light)' : plan0.throttle ? '' : ' (maximize)'}, db=${taskqHome()}\n`,
  );

  const drainDecision = throttledNow ? 'throttled' : plan0.decision.burnExpiring ? 'burning' : 'normal';
  const drainRunId = insertDrainRun(db, {
    startedAt: Date.now(),
    decision: drainDecision,
    reason,
    jobs: plan0.jobs,
    maxJobs: plan0.maxJobs,
  });

  // Heartbeat / pool-resize cadence: re-read config and refresh the liveness
  // stamp on the watchdog interval, capped at 30s so the UI's "last fired" stays
  // current even during a long pass (it would otherwise freeze at the launchd
  // start time, since launchd can't re-fire while this process is still alive).
  const tickMs = Math.min(currentInterval(), 30) * 1000;

  const summary = await runDrain(db, {
    jobs: plan0.jobs,
    desiredJobs: () => planDrain().jobs,
    executor,
    verifyDone,
    leaseTtlMs: config.leaseTtlMs,
    // Bounded auto-retry so one transient hiccup (a download that won't resolve, a
    // service down for a bit) can't strand the unattended run — the task is
    // re-queued with a backoff and retried, only parking `failed` after the cap.
    retry: { maxAttempts: config.maxAttempts, backoff: config.retryBackoff },
    worker: (i) => ({ filters: planDrain().perWorker[i] ?? {} }),
    tickMs,
    onTick: () => writeFileSync(lastFireFile, String(Date.now())),
    shouldStop: () => existsSync(stopFile),
    onEvent: (e) => {
      if (e.type === 'completed') {
        process.stdout.write(`  ✓ #${e.taskId} (${e.durationS}s) by w${e.worker}\n`);
        // A real call went through → we are NOT out of tokens. Adaptively learn:
        // if any bucket was reading exhausted, grow its limit + re-anchor so the
        // estimate stops blocking and tracks reality more closely next time.
        logReconcile(reconcileUsageObservation(db, 'not-exhausted'));
      } else if (e.type === 'rate-limited') {
        // A genuine usage-limit error: the task was RELEASED back to ready (not
        // failed) and the pool is winding down. Confirm we ARE out so the
        // estimate predicts the wall sooner; the next pass resumes after reset.
        process.stdout.write(`  ⏸ #${e.taskId}: usage limit (${e.reason}) — released, backing off this pass\n`);
        logReconcile(reconcileUsageObservation(db, 'exhausted'));
      } else if (e.type === 'retrying') {
        const inMin = Math.max(0, Math.round((e.retryAt - Date.now()) / 60_000));
        process.stdout.write(`  ↻ #${e.taskId}: ${e.reason} — retry ${e.attempts}/${e.maxAttempts} in ~${inMin}m\n`);
        // A retry means the call reached the API (the task just didn't finish) →
        // proof we are NOT out of tokens.
        logReconcile(reconcileUsageObservation(db, 'not-exhausted'));
      } else if (e.type === 'failed') {
        process.stdout.write(`  ✗ #${e.taskId} (failed ${e.attempts}/${e.maxAttempts}): ${e.reason}\n`);
        // The call reached the API (it just didn't finish the task) → proof we
        // are NOT out, so treat it as a not-exhausted signal. (Real usage-limit
        // failures come through the 'rate-limited' branch above instead.)
        logReconcile(reconcileUsageObservation(db, e.rateLimited ? 'exhausted' : 'not-exhausted'));
      } else if (e.type === 'false-done') {
        // A reported success that landed nothing / regressed the build — reverted to a
        // hold instead of done, so it never cascades to release downstream deps.
        process.stdout.write(`  ⚠ #${e.taskId}: FALSE-DONE (${e.reason}) → reverted to ${e.status} — ${e.note}\n`);
        // The call DID reach the API (the agent ran, it just didn't really land) →
        // proof we are NOT out of tokens.
        logReconcile(reconcileUsageObservation(db, 'not-exhausted'));
      } else if (e.type === 'error') {
        process.stderr.write(`  ! #${e.taskId} w${e.worker}: ${e.error}\n`);
      } else if (e.type === 'reaped') process.stdout.write(`  reaped ${e.count} stranded lease(s)\n`);
    },
  });

  // Empty-queue self-heal: nothing ran to give us a signal, yet the estimate
  // says we're out. Fire ONE cheap probe to find out for real, then reconcile —
  // so a stuck "0% remaining" corrects itself without waiting for a task. Skip it
  // when a worker already hit a real usage limit this pass (summary.rateLimited):
  // we KNOW we're out, so a probe would just waste a call during the outage.
  if (
    !dryRun &&
    !summary.rateLimited &&
    wasExhausted.length > 0 &&
    summary.completed + summary.failed + summary.retried === 0
  ) {
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
    `${ts()} taskq drain done: ${summary.completed} completed, ${summary.retried} retried, ${summary.failed} failed, ${summary.falseDone} false-done, ${summary.reaped} reaped\n`,
  );
}

if (import.meta.main)
  main().catch((e) => {
    process.stderr.write(`taskq drain error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
