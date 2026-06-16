/**
 * JSON / CSV dev-tool conversions — re-exported from cwip so rubato and the other
 * apps share one tolerant loose-JSON + CSV core (no two diverging copies).
 *
 * `formatJson`/`parseLoose` accept JS-isms (single quotes, unquoted keys, trailing
 * commas, comments) and emit clean JSON; `csvToJson`/`jsonToCsv`/`parseCsv` convert
 * between CSV and JSON. See `cwip/json` for the implementation + tests. Kept as a
 * stable `@shared/tools/json` shim so existing importers (and the `rubato` library
 * surface in `src/lib.ts`) don't change.
 */
export * from 'cwip/json';
