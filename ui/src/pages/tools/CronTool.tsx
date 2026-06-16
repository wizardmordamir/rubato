import { CRON_PRESETS, cronFieldDefs, explainCron, nextCronRuns } from "@shared/tools/cron";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { deleteSavedCron, fetchSavedCrons, saveCron } from "../../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, Tooltip } from "../../components";
import { useToast } from "../../toast";
import { ErrorNote, Field, SavedList } from "./toolkit";

/** "in 5 min" / "in 2 days" — a light relative label next to each run. */
function relative(date: Date, now: number): string {
  const ms = date.getTime() - now;
  if (ms < 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "in <1 min";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hr${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export function CronTool() {
  const [expression, setExpression] = useState("0 9 * * 1-5");

  const now = useMemo(() => Date.now(), [expression]);
  const explained = useMemo(() => explainCron(expression), [expression]);
  const runs = useMemo(() => nextCronRuns(expression, 6, new Date(now)), [expression, now]);

  const withSeconds = explained.fieldCount === 6;
  const defs = cronFieldDefs(withSeconds);
  const parts = expression.trim().split(/\s+/);

  const setField = (index: number, value: string) => {
    const next = Array.from({ length: defs.length }, (_, i) => parts[i] ?? "*");
    next[index] = value || "*";
    setExpression(next.join(" "));
  };
  const toggleSeconds = () => {
    const p = expression.trim().split(/\s+/);
    setExpression(withSeconds ? p.slice(1).join(" ") || "* * * * *" : ["0", ...p].join(" "));
  };

  // Saved schedules.
  const qc = useQueryClient();
  const { notify } = useToast();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const { data: saved = [] } = useQuery({ queryKey: ["saved-cron"], queryFn: fetchSavedCrons });

  const save = useMutation({
    mutationFn: () => saveCron({ title, expression, notes }),
    onSuccess: () => {
      setTitle("");
      setNotes("");
      notify("Saved", "success");
      qc.invalidateQueries({ queryKey: ["saved-cron"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteSavedCron(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-cron"] }),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <Field label="Expression">
          <div className="flex items-center gap-1.5">
            <input
              className={`${FIELD_CLASS} flex-1 font-mono`}
              value={expression}
              onChange={(e) => setExpression(e.target.value)}
              spellCheck={false}
              placeholder="0 9 * * 1-5"
            />
            <button type="button" className={BTN_GHOST_CLASS} onClick={toggleSeconds}>
              {withSeconds ? "− sec" : "+ sec"}
            </button>
          </div>
        </Field>
        <p className="text-xs text-gray-400">
          5-field crontab or 6-field with leading seconds. Macros like <code>@daily</code> and names like{" "}
          <code>MON</code> work too.
        </p>

        <Field label="Build it field-by-field">
          <div className="space-y-1.5">
            {defs.map((def, i) => (
              <div key={def.key} className="flex flex-wrap items-center gap-1.5">
                <span className="w-32 shrink-0 text-xs text-gray-500">
                  {def.label} <span className="text-gray-400">{def.help}</span>
                </span>
                <input
                  className={`${FIELD_CLASS} w-16 py-0.5 font-mono`}
                  value={parts[i] ?? "*"}
                  onChange={(e) => setField(i, e.target.value)}
                  spellCheck={false}
                />
                {def.presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`${BTN_GHOST_CLASS} py-0.5 font-mono`}
                    onClick={() => setField(i, p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Field>

        <Field label="Presets">
          <div className="flex flex-wrap gap-1">
            {CRON_PRESETS.map((p) => (
              <Tooltip key={p.label} content={`${p.expr} — ${p.description}`}>
                <button
                  type="button"
                  className={`${BTN_GHOST_CLASS} py-0.5`}
                  onClick={() => setExpression(p.expr)}
                >
                  {p.label}
                </button>
              </Tooltip>
            ))}
          </div>
        </Field>

        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 text-xs font-medium text-gray-500">Save this schedule</div>
          <div className="space-y-1.5">
            <div className="flex gap-1.5">
              <input
                className={`${FIELD_CLASS} flex-1 py-1`}
                placeholder="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={!title.trim() || !expression.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                Save
              </button>
            </div>
            <input
              className={`${FIELD_CLASS} w-full py-1`}
              placeholder="notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="mt-2">
            <SavedList
              items={saved.map((s) => ({ id: s.id, label: s.title, sub: s.expression }))}
              onLoad={(id) => {
                const found = saved.find((s) => s.id === id);
                if (found) {
                  setExpression(found.expression);
                  setTitle(found.title);
                  setNotes(found.notes);
                }
              }}
              onDelete={(id) => del.mutate(id)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 text-xs font-medium text-gray-500">What it means</div>
          <ErrorNote message={explained.ok ? undefined : explained.error} />
          {explained.ok && (
            <>
              <p className="mb-2 text-base font-semibold text-accent">{explained.summary}</p>
              <ul className="space-y-0.5 text-xs">
                {explained.fields.map((f) => (
                  <li key={f.name} className="flex items-baseline gap-2">
                    <span className="w-24 shrink-0 text-gray-400">{f.name}</span>
                    <code className="w-12 shrink-0 text-accent">{f.raw}</code>
                    <span className="text-gray-600 dark:text-gray-300">{f.desc}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 text-xs font-medium text-gray-500">Next runs</div>
          <ErrorNote message={runs.ok ? undefined : runs.error} />
          {runs.ok &&
            (runs.runs.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {runs.runs.map((d) => (
                  <li key={d.getTime()} className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-gray-700 dark:text-gray-200">{d.toLocaleString()}</span>
                    <span className="text-gray-400">{relative(d, now)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400">No upcoming runs found.</p>
            ))}
        </div>
      </div>
    </div>
  );
}
