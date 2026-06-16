/**
 * Diagnostics — rich, exportable failure/processing artifacts for debugging
 * rubato on other machines and against unfamiliar APIs. See `session.ts`.
 *
 * Two layers, kept separate on purpose:
 *   - pure (`shape.ts`, `report.ts`) — importable from `src/api/*` and other
 *     import-clean code; no fs/config/process.
 *   - impure (`session.ts`) — the file sink; import from server/script seams.
 */

export {
  classifyError,
  type DiagnosticError,
  type DiagnosticEvent,
  type DiagnosticReport,
  type DiagnosticStatus,
  type ErrorClass,
  type ShapeMismatch,
  toDiagnosticError,
} from './report';
export {
  type DiagnosticsOptions,
  type DiagnosticsResult,
  type DiagnosticsSession,
  startDiagnostics,
  withDiagnostics,
} from './session';
export {
  type DescribeOptions,
  describeShape,
  diffShape,
  type ShapeDescriptor,
  type ShapeDiff,
  type ShapeDiffKind,
  shapeToString,
} from './shape';
