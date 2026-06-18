import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  deleteOllamaModel,
  fetchOllamaModels,
  fetchOllamaRunning,
  fetchOllamaStatus,
  type OllamaModel,
  pullOllamaModel,
  setOllamaModel,
  startOllamaDaemon,
  stopOllamaModel,
} from "../api";
import { Alert, Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading } from "../components";
import { useConfirm } from "../confirm";
import { IconTrash } from "../icons";
import { useToast } from "../toast";

/**
 * Ollama control — the Orchestration "Ollama" tab. Watch daemon status, start it,
 * manage installed models, set rubato's active chat model (fixes "model is
 * required"), pull new models, and unload running ones.
 */

function fmtBytes(n: number): string {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function OllamaPage({ embedded }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const onError = (e: unknown) => notify(e instanceof Error ? e.message : "request failed", "error");

  const { data: status } = useQuery({
    queryKey: ["ollama-status"],
    queryFn: fetchOllamaStatus,
    refetchInterval: 4000,
  });
  const running = status?.running ?? false;

  const { data: models = [] } = useQuery({
    queryKey: ["ollama-models"],
    queryFn: fetchOllamaModels,
    enabled: running,
  });
  const { data: loaded = [] } = useQuery({
    queryKey: ["ollama-running"],
    queryFn: fetchOllamaRunning,
    enabled: running,
    refetchInterval: running ? 4000 : false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ollama-status"] });
    qc.invalidateQueries({ queryKey: ["ollama-models"] });
    qc.invalidateQueries({ queryKey: ["ollama-running"] });
  };

  const start = useMutation({ mutationFn: startOllamaDaemon, onSuccess: refresh, onError });
  const setActive = useMutation({
    mutationFn: setOllamaModel,
    onSuccess: (s) => {
      refresh();
      notify(`Active model set to ${s.model}`, "success");
    },
    onError,
  });
  const pull = useMutation({
    mutationFn: pullOllamaModel,
    onSuccess: () => {
      refresh();
      notify("Model pulled", "success");
    },
    onError,
  });
  const remove = useMutation({ mutationFn: deleteOllamaModel, onSuccess: refresh, onError });
  const unload = useMutation({ mutationFn: stopOllamaModel, onSuccess: refresh, onError });

  const [pullName, setPullName] = useState("");
  const loadedNames = new Set(loaded.map((m) => m.name));

  return (
    <div className="flex flex-col gap-4">
      {!embedded && <PageHeading title="Ollama" />}

      {/* Status */}
      <div className={`${CARD_CLASS} flex flex-wrap items-center gap-3`}>
        <Badge tone={running ? "success" : "error"}>{running ? "Running" : "Stopped"}</Badge>
        <span className="text-sm text-gray-600 dark:text-gray-300">
          {status?.baseUrl ?? "…"}
          {status?.version ? ` · v${status.version}` : ""}
        </span>
        <span className="text-sm">
          Active model:{" "}
          {status?.model ? <Badge tone="accent">{status.model}</Badge> : <Badge tone="warn">none set</Badge>}
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={refresh}>
            Refresh
          </button>
          {!running && (
            <button type="button" className={BTN_PRIMARY_CLASS} disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? "Starting…" : "Start Ollama"}
            </button>
          )}
        </div>
      </div>

      {!running && (
        <Alert tone="warning" title="Ollama is not reachable">
          Start the daemon above (runs <code>ollama serve</code>), or launch the Ollama app. The endpoint comes from
          rubato's <code>ai.direct.baseUrl</code> / <code>RUBATO_LLM_URL</code>.
        </Alert>
      )}

      {running && !status?.model && (
        <Alert tone="warning" title="No active model set">
          Forge/chat requests fail with “model is required” until you pick one. Click <strong>Use</strong> on an
          installed model below.
        </Alert>
      )}

      {/* Pull */}
      <div className={`${CARD_CLASS} flex flex-wrap items-center gap-2`}>
        <span className="text-sm font-medium">Pull a model</span>
        <input
          className={`${FIELD_CLASS} max-w-xs flex-1`}
          placeholder="e.g. llama3.2  or  qwen2.5-coder:7b"
          value={pullName}
          onChange={(e) => setPullName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pullName.trim()) pull.mutate(pullName.trim());
          }}
        />
        <button
          type="button"
          className={BTN_PRIMARY_CLASS}
          disabled={!running || pull.isPending || !pullName.trim()}
          onClick={() => pull.mutate(pullName.trim())}
        >
          {pull.isPending ? "Pulling… (can take a while)" : "Pull"}
        </button>
      </div>

      {/* Running models */}
      {loaded.length > 0 && (
        <div className={`${CARD_CLASS} flex flex-col gap-2`}>
          <span className="text-sm font-medium">Loaded in memory</span>
          {loaded.map((m) => (
            <div key={m.name} className="flex items-center gap-3 text-sm">
              <span className="font-mono">{m.name}</span>
              <Badge tone="neutral">{fmtBytes(m.size_vram)} VRAM</Badge>
              <button
                type="button"
                className={`${BTN_GHOST_CLASS} ml-auto`}
                disabled={unload.isPending}
                onClick={() => unload.mutate(m.name)}
              >
                Unload
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Installed models */}
      <div className={`${CARD_CLASS} flex flex-col gap-1`}>
        <span className="mb-1 text-sm font-medium">Installed models</span>
        {!running ? (
          <p className="py-6 text-center text-sm text-gray-500">Start Ollama to list models.</p>
        ) : models.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">No models installed — pull one above.</p>
        ) : (
          models.map((m: OllamaModel) => {
            const isActive = status?.model === m.name;
            return (
              <div
                key={m.name}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono">{m.name}</span>
                    {isActive && <Badge tone="accent">active</Badge>}
                    {loadedNames.has(m.name) && <Badge tone="success">loaded</Badge>}
                  </div>
                  <span className="text-xs text-gray-500">
                    {fmtBytes(m.size)}
                    {m.details?.parameter_size ? ` · ${m.details.parameter_size}` : ""}
                    {m.details?.quantization_level ? ` · ${m.details.quantization_level}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className={BTN_GHOST_CLASS}
                  disabled={isActive || setActive.isPending}
                  onClick={() => setActive.mutate(m.name)}
                >
                  {isActive ? "In use" : "Use"}
                </button>
                <button
                  type="button"
                  className={BTN_GHOST_CLASS}
                  onClick={async () => {
                    if (await confirm({ prompt: `Delete model "${m.name}"?`, confirmText: "Delete" }))
                      remove.mutate(m.name);
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
