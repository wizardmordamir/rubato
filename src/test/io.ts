/**
 * Test helper: a `ScriptIo` that captures everything a `run(args, io)` prints, so
 * a test can assert on a command's output + exit code without a subprocess.
 */

import type { ScriptIo } from '../lib/scriptIo';

export interface CapturedIo extends ScriptIo {
  /** stdout lines, in order. */
  readonly stdout: string[];
  /** stderr lines, in order. */
  readonly stderr: string[];
  /** All stdout joined with newlines. */
  out_(): string;
  /** All stderr joined with newlines. */
  err_(): string;
}

export function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    out_: () => stdout.join('\n'),
    err_: () => stderr.join('\n'),
  };
}
