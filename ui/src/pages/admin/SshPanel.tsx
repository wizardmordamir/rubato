import { useMutation, useQuery } from "@tanstack/react-query";
import { CopyButton } from "cwip/react";
import { fetchSshServers, openSshInTerminal, type SshServerSummary } from "../../api";
import {
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  Spinner,
} from "../../components";

function ServerRow({ server }: { server: SshServerSummary }) {
  const open = useMutation({
    mutationFn: () => openSshInTerminal(server.index),
  });

  return (
    <div className={`${CARD_CLASS} flex flex-col gap-3 p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-semibold text-sm">{server.label}</span>
          <span className="ml-2 text-xs text-gray-400">index {server.index}</span>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton text={server.command} tooltip="Copy SSH command" className={BTN_GHOST_CLASS}>
            Copy
          </CopyButton>
          <button
            type="button"
            disabled={open.isPending}
            onClick={() => open.mutate()}
            className={BTN_PRIMARY_CLASS}
            title="Open SSH session in a native terminal window"
          >
            {open.isPending && <Spinner />}
            Open in Terminal
          </button>
        </div>
      </div>

      <code className="block rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200 break-all">
        {server.command}
      </code>

      {open.isSuccess && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          Opened via {open.data.method} — check your desktop for the new terminal window.
        </p>
      )}
      {open.isError && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {open.error instanceof Error ? open.error.message : "Failed to open terminal"}
        </p>
      )}
    </div>
  );
}

/**
 * Admin panel for SSH server shortcuts — localhost only.
 * Lists configured servers from ~/.rubato/config.json → servers.ssh and lets
 * you open a native terminal session or copy the command.
 */
export function SshPanel() {
  const { data: servers, isLoading, error } = useQuery({
    queryKey: ["ssh-servers"],
    queryFn: fetchSshServers,
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <strong>Localhost only</strong> — this panel is only available when running rubato locally.
        It opens SSH sessions in a native terminal on your machine. Configure servers in{" "}
        <code>~/.rubato/config.json</code> under <code>servers.ssh</code>.
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}

      {error && (
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : "Failed to load SSH servers"}
        </p>
      )}

      {servers && servers.length === 0 && (
        <div className={`${CARD_CLASS} p-4`}>
          <p className="text-sm text-gray-500 mb-3">No SSH servers configured yet.</p>
          <p className="text-xs text-gray-400 mb-1">
            Add a <code>servers.ssh</code> array to <code>~/.rubato/config.json</code>:
          </p>
          <pre className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200 overflow-x-auto">{`{
  "servers": {
    "ssh": [
      {
        "label": "prod",
        "host": "myapp.example.com",
        "user": "ubuntu",
        "keyPath": "~/.ssh/id_ed25519"
      }
    ]
  }
}`}</pre>
          <p className="mt-2 text-xs text-gray-400">
            Optional fields: <code>port</code> (default 22), <code>extraArgs</code> (extra SSH flags).
            The <code>prod-ssh</code> shell command also reads this config.
          </p>
        </div>
      )}

      {servers && servers.length > 0 && (
        <div className="space-y-3">
          {servers.map((s) => (
            <ServerRow key={s.index} server={s} />
          ))}
          <p className="text-xs text-gray-400 mt-2">
            The <code>prod-ssh</code> shell command opens the same connections directly from your terminal.
          </p>
        </div>
      )}
    </div>
  );
}
