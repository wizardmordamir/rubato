import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Command, fetchCommands, type SavedCommand, type SavedCommandKind, saveCommand } from "./api";
import { Alert, FIELD_CLASS } from "./components";
import { Modal } from "./Modal";
import { useToast } from "./toast";

/** Split an args string into argv, respecting simple single/double quotes. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** Create or edit a saved command (an arbitrary shell line, or a registry invocation). */
export function SavedCommandModal({ initial, onClose }: { initial?: SavedCommand; onClose: () => void }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data: commands = [] } = useQuery({ queryKey: ["commands"], queryFn: fetchCommands });

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [kind, setKind] = useState<SavedCommandKind>(initial?.kind ?? "shell");
  const [shell, setShell] = useState(initial?.kind === "shell" ? initial.command : "");
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [builtin, setBuiltin] = useState(initial?.kind === "builtin" ? initial.command : "");
  const [argsText, setArgsText] = useState(initial?.kind === "builtin" ? (initial.args ?? []).join(" ") : "");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      saveCommand({
        id: initial?.id,
        name: name.trim(),
        description: description.trim(),
        kind,
        command: kind === "shell" ? shell.trim() : builtin,
        args: kind === "builtin" ? tokenize(argsText) : [],
        cwd: kind === "shell" ? cwd.trim() : undefined,
      }),
    onSuccess: () => {
      notify(initial ? "Command updated" : "Command saved", "success");
      qc.invalidateQueries({ queryKey: ["savedCommands"] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  function onSave() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    if (kind === "shell" && !shell.trim()) return setError("Shell command is required.");
    if (kind === "builtin" && !builtin) return setError("Pick a command.");
    save.mutate();
  }

  return (
    <Modal title={initial ? `Edit "${initial.name}"` : "New saved command"} onClose={onClose}>
      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. deploy myapp to stage" className={FIELD_CLASS} />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Description</span>
          <span className="ml-2 text-xs text-gray-500">optional</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what it does" className={FIELD_CLASS} />
        </label>

        <div>
          <span className="text-sm font-medium">Type</span>
          <div className="mt-1 flex gap-2">
            {(["shell", "builtin"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`rounded-lg border px-3 py-1 text-sm transition-colors ${
                  kind === k
                    ? "border-accent bg-accent-soft font-medium text-accent"
                    : "border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                {k === "shell" ? "Shell command" : "Built-in command"}
              </button>
            ))}
          </div>
        </div>

        {kind === "shell" ? (
          <>
            <label className="block">
              <span className="text-sm font-medium">Shell command</span>
              <textarea
                value={shell}
                onChange={(e) => setShell(e.target.value)}
                rows={3}
                placeholder="e.g. git -C ~/code/myapp pull --ff-only"
                className={`${FIELD_CLASS} font-mono`}
              />
              <span className="mt-1 block text-xs text-gray-500">Runs with bash on this machine. Output and history are recorded.</span>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Working directory</span>
              <span className="ml-2 text-xs text-gray-500">optional; defaults to the rubato repo</span>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="e.g. ~/code/myapp" className={`${FIELD_CLASS} font-mono`} />
            </label>
          </>
        ) : (
          <>
            <label className="block">
              <span className="text-sm font-medium">Command</span>
              <select value={builtin} onChange={(e) => setBuiltin(e.target.value)} className={FIELD_CLASS}>
                <option value="">— pick a command —</option>
                {commands.map((c: Command) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Preset args</span>
              <span className="ml-2 text-xs text-gray-500">space-separated, blank for none</span>
              <input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="e.g. myapp stage --yes" className={`${FIELD_CLASS} font-mono`} />
            </label>
          </>
        )}

        {error && (
          <Alert tone="error">
            {error}
          </Alert>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
        <button type="button" onClick={onClose} className="rounded px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={save.isPending}
          className="rounded-lg bg-accent px-4 py-1 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
