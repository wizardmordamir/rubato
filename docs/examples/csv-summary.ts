/**
 * Example custom script for a rubato pipeline.
 *
 * Copy this (and csv-summary.meta.json) into ~/.rubato/scripts/ and it shows up on
 * the web UI "Scripts" tab and as a `script` pipeline stage.
 *
 * It demonstrates the whole stage contract with no dependencies:
 *   - read an input file an earlier stage left in the per-run dir (RUBATO_RUN_DIR);
 *   - write a report into the output dir (RUBATO_OUTPUT_DIR) so it's downloadable
 *     in the Files tab;
 *   - hand a value forward to later stages via outputs.json.
 *
 * For a real .xlsx workbook, register an in-process function from your embedding
 * app instead and use your own `xlsx` dependency — same contract, full language
 * power (see docs/pipelines.md).
 */

import { resolve } from "node:path";

const runDir = process.env.RUBATO_RUN_DIR ?? ".";
const outputDir = process.env.RUBATO_OUTPUT_DIR ?? runDir;
// `input` comes from the pipeline vars bag / the Scripts param form; default to a
// file a prior Playwright stage saved as `${run.dir}/report.csv`.
const input = process.env.input ?? "report.csv";

const text = await Bun.file(resolve(runDir, input)).text();
const rows = text.split("\n").filter((line) => line.trim().length > 0);
const header = rows[0] ?? "";
const columns = header.split(",").length;
const dataRows = Math.max(0, rows.length - 1);

console.log(`Read ${input}: ${dataRows} data row(s), ${columns} column(s).`);

// Write a small report into the output dir → visible/downloadable in the UI.
const summary = `metric,value\nrows,${dataRows}\ncolumns,${columns}\n`;
await Bun.write(resolve(outputDir, "csv-summary.csv"), summary);

// Hand the row count forward to later stages.
await Bun.write(resolve(runDir, "outputs.json"), JSON.stringify({ vars: { rows: String(dataRows) } }));
