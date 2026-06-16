import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchBackups, fetchBackupTables, queryBackupTable, restoreBackup } from "../../api";
import { BTN_GHOST_CLASS, CARD_CLASS, FIELD_CLASS, Tooltip } from "../../components";
import { Modal } from "../../Modal";
import { useToast } from "../../toast";
import { TableQueryExplorer } from "./TableQueryExplorer";

/** Inspect a backup read-only and optionally restore selected tables over the live DB. */
export function BackupViewerPanel() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data: backups = [] } = useQuery({ queryKey: ["backups"], queryFn: fetchBackups });
  const [file, setFile] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);

  const { data: tables = [] } = useQuery({
    queryKey: ["backup-tables", file],
    queryFn: () => fetchBackupTables(file),
    enabled: !!file,
  });

  const restore = useMutation({
    mutationFn: () => restoreBackup(file, [...selected]),
    onSuccess: (r) => {
      const rows = r.restored.reduce((n, x) => n + x.rowsCopied, 0);
      notify(`Restored ${r.restored.length} table(s), ${rows} row(s). Safety: ${r.safetyBackup}`, "success");
      if (r.skipped.length) notify(`Skipped: ${r.skipped.map((s) => `${s.table} (${s.reason})`).join(", ")}`, "error");
      setSelected(new Set());
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ["backups"] });
      qc.invalidateQueries({ queryKey: ["db-stats"] });
    },
    onError: (e) => {
      notify(e instanceof Error ? e.message : "restore failed", "error");
      setConfirm(false);
    },
  });

  const toggle = (name: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const pick = (f: string) => {
    setFile(f);
    setSelected(new Set());
  };

  return (
    <div className="space-y-4">
      <select value={file} onChange={(e) => pick(e.target.value)} className={`${FIELD_CLASS} w-auto py-1.5`}>
        <option value="">select a backup…</option>
        {backups.map((b) => (
          <option key={b.fileName} value={b.fileName}>
            {b.fileName}
            {b.safety ? " (safety)" : ""}
          </option>
        ))}
      </select>

      {file && (
        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium">Restore tables</span>
            <span className="text-xs text-gray-400">overwrites the live table from this backup</span>
            <Tooltip
              multiline
              content="Overwrites the checked tables in the LIVE database with their rows from this backup — current rows in those tables are replaced. A safety snapshot of the live DB is taken first so you can roll back. You'll confirm before it runs."
            >
              <button
                type="button"
                disabled={selected.size === 0 || restore.isPending}
                onClick={() => setConfirm(true)}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
              >
                Restore {selected.size > 0 ? `${selected.size} selected` : "…"}
              </button>
            </Tooltip>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {tables.map((t) => (
              <label key={t.name} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={selected.has(t.name)} onChange={() => toggle(t.name)} />
                <span className="font-mono">{t.name}</span>
                <span className="text-gray-400">({t.rowCount})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {file && (
        <div className={`${CARD_CLASS} p-3`}>
          <p className="mb-2 text-xs text-gray-500">Browse this backup's rows (read-only).</p>
          <TableQueryExplorer tables={tables} runQuery={(table, body) => queryBackupTable(file, table, body)} />
        </div>
      )}

      {confirm && (
        <Modal title="Restore from backup" onClose={() => setConfirm(false)}>
          <p className="text-sm">
            This overwrites {selected.size} live table(s) with rows from{" "}
            <span className="font-mono">{file}</span>. A safety snapshot of the current DB is taken first, so you can
            roll back.
          </p>
          <p className="mt-2 text-xs text-gray-500">Tables: {[...selected].join(", ")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirm(false)} className={`${BTN_GHOST_CLASS} px-3 py-1.5 text-sm`}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => restore.mutate()}
              disabled={restore.isPending}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
            >
              {restore.isPending ? "Restoring…" : "Restore now"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
