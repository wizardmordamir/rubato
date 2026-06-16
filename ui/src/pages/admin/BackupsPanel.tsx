import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backupDownloadUrl, createBackup, deleteBackup, fetchBackups } from "../../api";
import { Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, OpenPathButton, Tooltip } from "../../components";
import { useConfirm } from "../../confirm";
import { useToast } from "../../toast";
import { fmtBytes, when } from "./format";

/** Create / list / delete / download SQLite snapshots of the rubato DB. */
export function BackupsPanel() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { data: backups = [] } = useQuery({ queryKey: ["backups"], queryFn: fetchBackups });

  const create = useMutation({
    mutationFn: createBackup,
    onSuccess: (b) => {
      notify(`Snapshot created (${fmtBytes(b.size)})`, "success");
      qc.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "backup failed", "error"),
  });

  const remove = useMutation({
    mutationFn: deleteBackup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backups"] }),
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <p className="text-xs text-gray-500">
          Point-in-time <span className="font-mono">VACUUM INTO</span> snapshots of{" "}
          <span className="font-mono">rubato.sqlite</span>, stored in{" "}
          <span className="font-mono">~/.rubato/backups</span>
          <OpenPathButton path="~/.rubato/backups" />.
        </p>
        <Tooltip
          multiline
          content="Writes a point-in-time copy of the whole database (a SQLite VACUUM INTO) to ~/.rubato/backups. It's a consistent, compacted snapshot you can download or later restore tables from — it doesn't change the live DB."
        >
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className={`${BTN_PRIMARY_CLASS} ml-auto px-3 py-1.5 text-xs`}
          >
            {create.isPending ? "Creating…" : "Create snapshot"}
          </button>
        </Tooltip>
      </div>
      {backups.length === 0 ? (
        <p className="text-gray-400">No snapshots yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {backups.map((b) => (
            <li key={b.fileName} className={`${CARD_CLASS} flex flex-wrap items-center gap-2 px-3 py-2`}>
              <span className="font-mono text-xs">{b.fileName}</span>
              {b.safety && <Badge tone="accent">safety</Badge>}
              <span className="text-xs text-gray-400">
                {fmtBytes(b.size)} · {when(b.modifiedAt)}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <OpenPathButton path={`~/.rubato/backups/${b.fileName}`} />
                <a
                  href={backupDownloadUrl(b.fileName)}
                  download
                  className={`${BTN_GHOST_CLASS} px-2 py-0.5 text-xs`}
                >
                  Download
                </a>
                <Tooltip
                  multiline
                  content="Permanently deletes this snapshot file from ~/.rubato/backups. It does not affect the live database — only this saved copy is removed, and it can't be recovered."
                >
                  <button
                    type="button"
                    onClick={async () => {
                      if (await confirm({ prompt: "Delete this backup?", confirmText: "Delete" }))
                        remove.mutate(b.fileName);
                    }}
                    disabled={remove.isPending}
                    className={`${BTN_GHOST_CLASS} px-2 py-0.5 text-xs`}
                  >
                    Delete
                  </button>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
