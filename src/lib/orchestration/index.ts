/**
 * Orchestration library barrel — the pure parsers, aggregators, and formatters
 * behind the rubato Orchestration page (the area that tracks the unattended
 * "drain the task queue" workflows).
 *
 * Everything here is pure (string/data in, model out — no fs/server/db imports),
 * so it's importable as the `rubato/orchestration` subpath without dragging in the
 * server, and the library-import-boundary guard stays green. The file reads/writes
 * that feed these live in `src/server/orchestration.ts`.
 */

// Re-export the wire types so a `rubato/orchestration` consumer gets the model too.
export type {
  ActiveRun,
  CategoryStat,
  ConfigPatchResult,
  DrainConfig,
  DrainConfigPatch,
  FileLocation,
  FleetPreset,
  FleetTier,
  GroupRollup,
  HistoryEntry,
  LaunchdInfo,
  LogFileInfo,
  LogTail,
  OrchestrationFileDoc,
  OrchestrationFileInfo,
  OrchestrationOverview,
  OrchestrationStats,
  PendingChange,
  Problem,
  RepoStat,
  RestartResult,
  SaveFleetPreset,
  RunEntry,
  RunStatus,
  ThinkingLevel,
  TimingIngestResult,
  TimingOverview,
  TimingQueryParams,
  TimingRow,
  TimingSource,
  TimingSummary,
  TimingTrendPoint,
  WatchdogAgentResult,
  WatchdogCommand,
  WatchdogCounts,
  WatchdogSnapshot,
  WatchdogStatusLine,
  WatchdogTick,
  WorkerInstance,
  WorkerProcess,
  WorkflowBoard,
  WorkflowTask,
  WorkflowTaskMeta,
  WorkflowTaskStatus,
} from '../../shared/orchestration';
export {
  bucketTimingTrend,
  fleetPresetId,
  THINKING_LEVELS,
  thinkingTokensFor,
  WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUSES,
} from '../../shared/orchestration';
export { formatDuration, formatTokens, formatUsd } from './format';
export { parseDurationSeconds, parseHistory } from './parseHistory';
export { parseRunsJsonl, runEntryFromJson, summarizeRunEntries, type WorkerRunStats } from './parseRuns';
export { emptyTaskBoard, parseTaskBoard } from './parseTasks';
export { aggregateStats } from './stats';
export {
  applyDrainPatch,
  buildWatchdogCommands,
  type CommandPaths,
  changedDrainFields,
  computePending,
  defaultDrainConfig,
  deriveInstances,
  deriveNextRun,
  deriveProblems,
  type NextRun,
  needsRestartFieldChanged,
  nextRunIso,
  type ProblemInput,
  parseActiveRun,
  parseDrainConfig,
  parseFleetPresets,
  parseLaunchdPlist,
  parseWatchdogStatus,
  parseWatchdogTick,
  repoFromText,
  sanitizeFleetTiers,
  serializeDrainConfig,
  serializeFleetPresets,
  setPlistInterval,
  upsertFleetPreset,
  type WakeAction,
  wakeAction,
  workerIdFromWorktree,
} from './watchdog';
