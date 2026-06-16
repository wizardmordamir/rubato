/**
 * A tiny output seam for command scripts. A script's logic lives in an exported
 * `run(args, io)` that writes through `ScriptIo` and *returns* an exit code
 * instead of calling `process.exit`. `main()` is then a thin wrapper:
 *
 *   export async function run(args: string[], io: ScriptIo = consoleIo): Promise<number> { … }
 *   if (import.meta.main) process.exit(await run(process.argv.slice(2)));
 *
 * This makes command logic — arg parsing, branching, exit codes, what gets
 * printed — unit-testable in-process: a test calls `run([...], captureIo())` and
 * asserts the return code + captured lines, with no subprocess and no
 * `process.exit` tearing down the test runner.
 */

export interface ScriptIo {
  /** A line to stdout (the command's primary output). */
  out(line: string): void;
  /** A line to stderr (diagnostics, progress, warnings). */
  err(line: string): void;
}

/** The default IO: straight to the console. */
export const consoleIo: ScriptIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};
