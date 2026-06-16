/**
 * Pure display formatters for the Orchestration page. They live in the shared
 * model (`src/shared/orchestration.ts` — browser-safe, no I/O) so the UI can pull
 * them via the `@shared` alias without a dist build; re-exported here so a
 * `rubato/orchestration` library consumer gets them from the same barrel.
 */

export { formatDuration, formatTokens, formatUsd } from '../../shared/orchestration';
