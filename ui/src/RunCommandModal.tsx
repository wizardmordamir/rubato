import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Command, type RunRecord, runCommand, saveCommand } from "./api";
import { Alert, Badge, OpenPathButton } from "./components";
import { Modal } from "./Modal";
import { ReportLinks } from "./ReportLinks";
import { useToast } from "./toast";

/** Split an example/arg string into argv, respecting simple single/double quotes. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function RunCommandModal({
  command,
  onClose,
  prefill,
  lockArgs,
}: {
  command: Command;
  onClose: () => void;
  /** Initial values for named args (e.g. lock the app this command runs against). */
  prefill?: Record<string, string>;
  /** Arg names rendered read-only (e.g. the app/env the panel scoped to). */
  lockArgs?: string[];
}) {
  const qc = useQueryClient();
  const { notify } = useToast();

  const args = command.args ?? [];
  const flags = command.flags ?? [];
  const structured = args.length > 0 || flags.length > 0;
  const isLocked = (name: string) => !!lockArgs?.includes(name);

  // Per-positional values, per-flag checked + value, plus a freeform fallback.
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(prefill ?? {}) }));
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [flagValues, setFlagValues] = useState<Record<string, string>>({});
  const [freeform, setFreeform] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The last run's result + the argv that produced it, shown inline (no auto-close).
  const [lastRun, setLastRun] = useState<RunRecord | null>(null);
  const [lastArgv, setLastArgv] = useState<string[]>([]);
  const [saveName, setSaveName] = useState("");

  const run = useMutation({
    mutationFn: (argv: string[]) => runCommand(command.name, argv),
    onSuccess: (r, argv) => {
      notify(`${r.command} → exit ${r.exitCode}`, r.exitCode === 0 ? "success" : "error");
      setLastRun(r);
      setLastArgv(argv);
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["runHistory", command.name] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const save = useMutation({
    mutationFn: () =>
      saveCommand({
        name: saveName.trim() || `${command.name} ${lastArgv.join(" ")}`.trim(),
        kind: "builtin",
        command: command.name,
        args: lastArgv,
      }),
    onSuccess: () => {
      notify("Saved to your commands", "success");
      qc.invalidateQueries({ queryKey: ["savedCommands"] });
      setSaveName("");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  // Build argv from the form state (pure; skips empty values).
  function assemble(): string[] {
    if (!structured) return tokenize(freeform);
    const argv: string[] = [];
    for (const a of args) {
      const v = (values[a.name] ?? "").trim();
      if (v) argv.push(...tokenize(v));
    }
    for (const f of flags) {
      if (!checked[f.flag]) continue;
      argv.push(f.flag);
      const fv = (flagValues[f.flag] ?? "").trim();
      if (f.takesValue && fv) argv.push(fv);
    }
    if (freeform.trim()) argv.push(...tokenize(freeform));
    return argv;
  }

  function onRun(argv: string[]) {
    setError(null);
    run.mutate(argv);
  }

  function onRunForm() {
    const missing = args.find((a) => a.required && !(values[a.name] ?? "").trim());
    if (missing) {
      setError(`"${missing.name}" is required.`);
      return;
    }
    onRun(assemble());
  }

  const previewArgv = assemble();

  return (
    <Modal title={`${command.name} ${command.kind === "cd" ? "(cd)" : ""}`.trim()} onClose={onClose}>
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{command.description}</p>
      {command.kind === "cd" && (
        <Alert tone="warning" className="mb-3">
          This is a cd-command — running it here just prints the target path (it can't change your shell's directory).
        </Alert>
      )}

      {structured ? (
        <div className="space-y-4">
          {args.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Arguments</h4>
              <div className="space-y-2">
                {args.map((a) => (
                  <label key={a.name} className="block">
                    <span className="text-sm font-medium">
                      {a.name}
                      {a.required && <span className="text-red-500"> *</span>}
                    </span>
                    <span className="ml-2 text-xs text-gray-500">{a.description}</span>
                    {isLocked(a.name) && <span className="ml-2 text-xs text-accent">(fixed for this app)</span>}
                    <input
                      value={values[a.name] ?? ""}
                      readOnly={isLocked(a.name)}
                      onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
                      placeholder={a.example ? `e.g. ${a.example}` : a.name}
                      className={`mt-1 w-full rounded border border-gray-300 bg-transparent px-2 py-1 text-sm dark:border-gray-700 ${
                        isLocked(a.name) ? "cursor-not-allowed bg-gray-100 dark:bg-gray-800/60" : ""
                      }`}
                    />
                  </label>
                ))}
              </div>
            </section>
          )}

          {flags.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Flags</h4>
              <div className="space-y-1.5">
                {flags.map((f) => (
                  <div key={f.flag} className="flex items-center gap-2">
                    <label className="flex flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!checked[f.flag]}
                        onChange={(e) => setChecked((c) => ({ ...c, [f.flag]: e.target.checked }))}
                      />
                      <span className="font-mono text-sm">{f.flag}</span>
                      <span className="text-xs text-gray-500">{f.description}</span>
                    </label>
                    {f.takesValue && checked[f.flag] && (
                      <input
                        value={flagValues[f.flag] ?? ""}
                        onChange={(e) => setFlagValues((v) => ({ ...v, [f.flag]: e.target.value }))}
                        placeholder={f.example ?? "value"}
                        className="w-40 rounded border border-gray-300 bg-transparent px-2 py-0.5 text-sm dark:border-gray-700"
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : (
        <label className="block">
          <span className="text-sm font-medium">Args</span>
          <span className="ml-2 text-xs text-gray-500">space-separated, blank for none</span>
          <input
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            placeholder="e.g. --dry-run"
            className="mt-1 w-full rounded border border-gray-300 bg-transparent px-2 py-1 text-sm dark:border-gray-700"
          />
        </label>
      )}

      {structured && (
        <label className="mt-3 block">
          <span className="text-xs text-gray-400">extra args (anything not above)</span>
          <input
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            placeholder="optional"
            className="mt-1 w-full rounded border border-gray-200 bg-transparent px-2 py-1 text-xs dark:border-gray-800"
          />
        </label>
      )}

      {command.examples && command.examples.length > 0 && (
        <section className="mt-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Examples</h4>
          <div className="space-y-1">
            {command.examples.map((ex) => (
              <div key={ex.args} className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
                  {command.name} {ex.args}
                  {ex.note && <span className="ml-2 text-gray-400">— {ex.note}</span>}
                </code>
                <button
                  type="button"
                  onClick={() => onRun(tokenize(ex.args))}
                  disabled={run.isPending}
                  className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  Run
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {lastRun && (
        <section className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Result</h4>
            <Badge tone={lastRun.exitCode === 0 ? "success" : "error"}>exit {lastRun.exitCode}</Badge>
            <span className="text-xs text-gray-400">{lastRun.durationMs}ms</span>
          </div>
          {lastRun.output.trim() ? (
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-gray-800/60">
              {lastRun.output}
            </pre>
          ) : (
            <p className="mt-2 text-xs text-gray-400">(no output)</p>
          )}
          {lastRun.outputPath && (
            <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
              <span className="font-medium">Output:</span>
              <code className="truncate font-mono">{lastRun.outputPath}</code>
              <OpenPathButton path={lastRun.outputPath} title={`Open output ${lastRun.outputPath} in editor`} />
            </div>
          )}
          {lastRun.diagnosticPath && (
            <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
              <span className="font-medium">Diagnostic:</span>
              <code className="truncate font-mono">{lastRun.diagnosticPath}</code>
              <OpenPathButton
                path={lastRun.diagnosticPath}
                title={`Open diagnostic ${lastRun.diagnosticPath} in editor`}
              />
            </div>
          )}
          {lastRun.reportPath && <ReportLinks reportPath={lastRun.reportPath} className="mt-2" />}
          <div className="mt-2 flex items-center gap-2">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder={`save as… (default: ${command.name} ${lastArgv.join(" ")}`.trim() + ")"}
              className="flex-1 rounded border border-gray-300 bg-transparent px-2 py-1 text-xs dark:border-gray-700"
            />
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {save.isPending ? "Saving…" : "Save as command"}
            </button>
          </div>
        </section>
      )}

      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-3 dark:border-gray-800">
        <code className="truncate text-xs text-gray-400">
          {command.name} {previewArgv.join(" ")}
        </code>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onRunForm}
            disabled={run.isPending}
            className="rounded-lg bg-accent px-4 py-1 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {run.isPending ? "Running…" : "Run"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
