import { useQuery } from "@tanstack/react-query";
import { deleteArchive, fetchArchives } from "../api";
import { useApiMutation } from "../apiHooks";
import { Badge, CARD_CLASS, PageHeading } from "../components";
import { useConfirm } from "../confirm";

export function ArchivesPage() {
  const confirm = useConfirm();
  const { data = [] } = useQuery({ queryKey: ["archives"], queryFn: fetchArchives });

  const del = useApiMutation({
    mutationFn: (_c, id: number) => deleteArchive(id),
    successToast: "Archive deleted",
    invalidateKeys: [["archives"]],
  });

  return (
    <div>
      <PageHeading title="Archives" count={data.length} />
      <p className="mb-3 text-xs text-gray-400">Runs you've kept on purpose. These survive new runs until you delete them.</p>
      {data.length === 0 && <p className="text-gray-400">No archives yet — archive a run from the Runs page.</p>}
      <ul className="space-y-2">
        {data.map((a) => (
          <li key={a.id} className={`${CARD_CLASS} p-3`}>
            <div className="flex items-center gap-2">
              <span className="font-medium">{a.command}</span>
              {a.args.length > 0 && <span className="font-mono text-xs text-gray-500">{a.args.join(" ")}</span>}
              <Badge tone={a.exitCode === 0 ? "success" : "error"} className="ml-auto">
                exit {a.exitCode}
              </Badge>
              <span className="text-xs text-gray-400">archived {new Date(a.archivedAt).toLocaleString()}</span>
              <button
                type="button"
                onClick={async () => {
                  if (await confirm({ prompt: "Delete this archive?", confirmText: "Delete" })) del.mutate(a.id);
                }}
                disabled={del.isPending}
                className="rounded-lg border border-red-300 px-2 py-0.5 text-xs text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
              >
                Delete
              </button>
            </div>
            {a.output.trim() && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-500 hover:text-accent">output</summary>
                <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-gray-800/60">
                  {a.output}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
