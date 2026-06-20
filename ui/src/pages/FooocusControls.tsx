import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FooocusServerId, type FooocusServerStatus, fooocusServerView } from "@shared/fooocus";
import { fetchFooocusStatus, startFooocusServer, stopFooocusServer } from "../api";
import { Badge, CARD_CLASS, Switch, Tooltip } from "../components";
import { useToast } from "../toast";

/**
 * Compact Fooocus control strip for the chat page. One toggle per local server —
 * the Fooocus-API (`api`, :8888, what the art engine calls) and the standalone
 * Gradio web UI (`ui`, :7865). The toggle reflects live state (polled), starts a
 * stopped server, and stops one rubato started. An already-running (external)
 * server is shown but left alone, and a missing install disables the toggle
 * instead of erroring — see ../../src/shared/fooocus.ts (fooocusServerView).
 */
export function FooocusControls() {
  const qc = useQueryClient();
  const { notify } = useToast();

  const { data } = useQuery({
    queryKey: ["fooocus-status"],
    queryFn: fetchFooocusStatus,
    refetchInterval: 3000, // keep the toggles in sync with reality
  });

  const toggle = useMutation({
    mutationFn: ({ which, on }: { which: FooocusServerId; on: boolean }) =>
      on ? startFooocusServer(which) : stopFooocusServer(which),
    // The action returns the full status — apply it immediately, then polling continues.
    onSuccess: (status) => qc.setQueryData(["fooocus-status"], status),
    onError: (e) => notify(e instanceof Error ? e.message : "Fooocus action failed", "error"),
  });

  if (!data) return null; // first load — don't flash an empty strip

  const servers: FooocusServerStatus[] = [data.api, data.ui];

  return (
    <div className={`${CARD_CLASS} mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2 text-sm`}>
      <span className="flex items-center gap-1 font-medium text-gray-500 dark:text-gray-400">
        🎨 Fooocus
        <Tooltip
          multiline
          content="Start/stop the local Fooocus servers. API (:8888) powers in-app art generation; Web UI (:7865) is the standalone Fooocus interface. Toggling on starts it (or leaves an already-running one alone); rubato only stops servers it started."
        >
          <span className="cursor-help text-gray-400">ⓘ</span>
        </Tooltip>
      </span>

      {servers.map((s) => {
        const view = fooocusServerView(s);
        const busy = toggle.isPending && toggle.variables?.which === s.id;
        const tone = busy ? "warn" : view.tone;
        const text = busy ? "Working…" : view.text;
        const disabled = busy || !view.toggleEnabled;
        // Wrap in a span so the tooltip still fires when the switch is disabled.
        const control = (
          <span className="inline-flex">
            <Switch
              on={s.running || s.starting}
              disabled={disabled}
              onChange={(on) => toggle.mutate({ which: s.id, on })}
              label={`${s.label} ${s.running ? "on" : "off"}`}
            />
          </span>
        );
        return (
          <div key={s.id} className="flex items-center gap-2">
            {disabled && view.reason ? <Tooltip content={view.reason}>{control}</Tooltip> : control}
            <span className="font-medium">{s.label}</span>
            <span className="text-xs text-gray-400">:{s.port}</span>
            <Badge tone={tone}>{text}</Badge>
            {s.error && !busy && (
              <Tooltip content={s.error}>
                <span className="cursor-help text-amber-500">⚠</span>
              </Tooltip>
            )}
            {s.running && (
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent hover:underline"
                title={`Open ${s.url}`}
              >
                open ↗
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
