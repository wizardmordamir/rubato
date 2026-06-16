/**
 * The request "kit": the canonical HTTP request model + pure transforms (curl ⇄
 * request, request → fetch, variable interpolation, import/export file format)
 * and a curl parser. No React/server/Node deps — designed to be lifted into a
 * standalone package shared by rubato and cursedalchemy.
 */

export * from './model';
export * from './parseCurl';
export * from './transforms';
