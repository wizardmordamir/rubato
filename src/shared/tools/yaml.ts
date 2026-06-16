/**
 * Pure YAML format/convert helper, wrapping the `yaml` package. Parses input
 * and re-stringifies it with the given options (indent, key sorting), or emits
 * JSON instead when `toJson` is set. YAML is a superset of JSON, so this also
 * doubles as a JSON↔YAML converter: paste either, format as YAML, or flip
 * `toJson` to go the other way. Parse failures come back as a not-ok result
 * with the parser's message and, when available, the offending line/column.
 *
 * No React/DOM/Node deps — only the `yaml` lib + plain TS, so it bundles in a
 * browser.
 */

import { parse, stringify, YAMLParseError } from 'yaml';

export interface YamlFormatOptions {
  indent: number;
  sortKeys: boolean;
  toJson: boolean;
}

export interface YamlFormatResult {
  ok: boolean;
  output: string;
  error?: string;
  errorLine?: number;
  errorCol?: number;
}

export const formatYaml = (input: string, opts: YamlFormatOptions): YamlFormatResult => {
  if (!input.trim()) return { ok: true, output: '' };
  try {
    const value = parse(input);
    if (opts.toJson) {
      return { ok: true, output: JSON.stringify(value, null, opts.indent) };
    }
    const output = stringify(value, {
      indent: opts.indent,
      sortMapEntries: opts.sortKeys,
      lineWidth: 0, // never wrap long scalars
    });
    return { ok: true, output: output.trimEnd() };
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const pos = err.linePos?.[0];
      return {
        ok: false,
        output: '',
        error: err.message.split('\n')[0],
        errorLine: pos?.line,
        errorCol: pos?.col,
      };
    }
    return { ok: false, output: '', error: err instanceof Error ? err.message : 'Parse error' };
  }
};
