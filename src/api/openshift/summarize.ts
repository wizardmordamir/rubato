/**
 * Pure pod normalization + roll-up — the "how many pods, how many failing" math
 * (pipelines use-case 6), kept apart from the HTTP client so it's testable on
 * plain k8s JSON. Operates on the `PodList.items` a namespace returns.
 */

/** Raw k8s Pod fields we read (everything else is ignored). */
export interface RawPod {
  metadata?: { name?: string; creationTimestamp?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string; // Pending | Running | Succeeded | Failed | Unknown
    startTime?: string;
    containerStatuses?: {
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: {
        waiting?: { reason?: string };
        terminated?: { reason?: string };
        running?: Record<string, unknown>;
      };
    }[];
  };
}

export interface RawPodList {
  items?: RawPod[];
}

/** A normalized pod: phase, readiness, restart count, and a problem reason if any. */
export interface OpenshiftPod {
  name: string;
  phase: string;
  /** Every container ready (or, with no container statuses, phase is Running). */
  ready: boolean;
  /** Sum of container restart counts. */
  restarts: number;
  node?: string;
  startedAt?: string;
  /** Why the pod is problematic (CrashLoopBackOff, ImagePullBackOff, Failed, NotReady…), else undefined. */
  reason?: string;
}

/** A namespace's pod roll-up. */
export interface PodSummary {
  pods: OpenshiftPod[];
  total: number;
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
  /** Running pods that aren't fully ready. */
  notReady: number;
  /** Sum of all restart counts. */
  restarts: number;
  /** Failed / not-ready / waiting-with-a-bad-reason pods (name + reason). */
  problematic: { name: string; reason: string }[];
}

/** Normalize one raw pod. */
export function mapPod(raw: RawPod): OpenshiftPod {
  const phase = raw.status?.phase ?? 'Unknown';
  const containers = raw.status?.containerStatuses ?? [];
  const ready = containers.length > 0 ? containers.every((c) => c.ready === true) : phase === 'Running';
  const restarts = containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
  const waitingReason = containers.map((c) => c.state?.waiting?.reason).find(Boolean);
  const terminatedReason = containers.map((c) => c.state?.terminated?.reason).find((r) => r && r !== 'Completed');

  let reason: string | undefined;
  if (waitingReason) reason = waitingReason;
  else if (phase === 'Failed') reason = terminatedReason ?? 'Failed';
  else if (phase === 'Running' && !ready) reason = 'NotReady';
  else if (phase === 'Unknown') reason = 'Unknown';

  return {
    name: raw.metadata?.name ?? '',
    phase,
    ready,
    restarts,
    node: raw.spec?.nodeName,
    startedAt: raw.status?.startTime,
    reason,
  };
}

/** Roll up a namespace's pods (the items array) into counts + a problem list. */
export function summarizePods(rawPods: RawPod[]): PodSummary {
  const pods = rawPods.map(mapPod);
  const summary: PodSummary = {
    pods,
    total: pods.length,
    running: 0,
    pending: 0,
    succeeded: 0,
    failed: 0,
    notReady: 0,
    restarts: 0,
    problematic: [],
  };
  for (const pod of pods) {
    summary.restarts += pod.restarts;
    if (pod.phase === 'Running') summary.running++;
    else if (pod.phase === 'Pending') summary.pending++;
    else if (pod.phase === 'Succeeded') summary.succeeded++;
    else if (pod.phase === 'Failed') summary.failed++;
    if (pod.phase === 'Running' && !pod.ready) summary.notReady++;
    if (pod.reason) summary.problematic.push({ name: pod.name, reason: pod.reason });
  }
  return summary;
}
