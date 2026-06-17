import { useQuery } from "@tanstack/react-query";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import rehypeHighlight from "rehype-highlight";
import {
  type Command,
  deleteSavedCommand,
  fetchCommands,
  fetchCommandSource,
  fetchSavedCommands,
  type RunRecord,
  runSavedCommand,
  type SavedCommand,
} from "../api";
import { useApiMutation } from "../apiHooks";
import {
  Badge,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  CARD_INTERACTIVE_CLASS,
  OpenPathButton,
  PageHeading,
  SearchInput,
  Tooltip,
} from "../components";
import { useConfirm } from "../confirm";
import { IconFileText, IconPlay, IconPlus, IconTrash } from "../icons";
import { ReportLinks } from "../ReportLinks";
import { RunCommandModal } from "../RunCommandModal";
import { RunHistory } from "../RunHistory";
import { SavedCommandModal } from "../SavedCommandModal";
import { useToast } from "../toast";
import { CopyButton } from "./tools/toolkit";

// ── sorting + run-stat display (shared by both command lists) ────────────────

type SortKey = "name" | "newest" | "oldest" | "recent" | "leastRecent" | "mostRun" | "leastRun";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name (A–Z)" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "recent", label: "Most recently ran" },
  { value: "leastRecent", label: "Least recently ran" },
  { value: "mostRun", label: "Most often ran" },
  { value: "leastRun", label: "Least often ran" },
];

interface Sortable {
  name: string;
  createdAt?: number;
  runCount?: number;
  lastRunAt?: number;
}

/**
 * Sort a command list by the chosen key. Built-in commands have no `createdAt`, so
 * under Newest/Oldest they fall back to name order; never-ran items sort last under
 * the run-based keys. Name is always the tiebreaker for a stable order.
 */
function sortCommands<T extends Sortable>(list: T[], key: SortKey): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const arr = [...list];
  switch (key) {
    case "newest":
      return arr.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || byName(a, b));
    case "oldest":
      return arr.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || byName(a, b));
    case "recent":
      return arr.sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || byName(a, b));
    case "leastRecent":
      return arr.sort((a, b) => {
        // never-ran (no lastRunAt) sort last; among ran, oldest run first.
        if (a.lastRunAt == null && b.lastRunAt == null) return byName(a, b);
        if (a.lastRunAt == null) return 1;
        if (b.lastRunAt == null) return -1;
        return a.lastRunAt - b.lastRunAt || byName(a, b);
      });
    case "mostRun":
      return arr.sort((a, b) => (b.runCount ?? 0) - (a.runCount ?? 0) || byName(a, b));
    case "leastRun":
      return arr.sort((a, b) => (a.runCount ?? 0) - (b.runCount ?? 0) || byName(a, b));
    default:
      return arr.sort(byName);
  }
}

const SORT_STORAGE_KEY = "rubato.commands.sort";

function usePersistedSort(): [SortKey, (k: SortKey) => void] {
  const [sort, setSort] = useState<SortKey>(() => {
    try {
      const s = localStorage.getItem(SORT_STORAGE_KEY) as SortKey | null;
      if (s && SORT_OPTIONS.some((o) => o.value === s)) return s;
    } catch {
      /* localStorage unavailable */
    }
    return "name";
  });
  const set = (k: SortKey) => {
    setSort(k);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, k);
    } catch {
      /* ignore */
    }
  };
  return [sort, set];
}

/** "3m ago" / "2d ago" — coarse relative time for a last-run timestamp. */
function relTime(ms?: number): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** "ran 4× · last 2d ago" — a command's run stats, or "never run". */
function RunStatLine({ runCount, lastRunAt }: { runCount?: number; lastRunAt?: number }) {
  if (!runCount) return <span className="text-xs text-gray-400">never run</span>;
  return (
    <span className="text-xs text-gray-400">
      ran {runCount}× · last {relTime(lastRunAt)}
    </span>
  );
}

/** Tech tags (git/jenkins/mongodb/…) for a command, as small chips. */
function CommandTagChips({ tags }: { tags?: string[] }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tags.map((t) => (
        <Badge key={t} tone="neutral" className="px-1.5 py-0 text-[10px]">
          {t}
        </Badge>
      ))}
    </div>
  );
}

/** One user-saved command: run it, see the latest result inline, view its history. */
function SavedCommandCard({ cmd, onEdit }: { cmd: SavedCommand; onEdit: (c: SavedCommand) => void }) {
  const { notify } = useToast();
  const confirm = useConfirm();
  const [result, setResult] = useState<RunRecord | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // A run "succeeds" even on a non-zero exit, so the toast variant depends on the
  // result — handled in onSuccess rather than the always-success successToast.
  const run = useApiMutation({
    mutationFn: () => runSavedCommand(cmd.id),
    invalidateKeys: [["runHistory", cmd.name], ["runs"]],
    onSuccess: (r) => {
      setResult(r);
      notify(`${cmd.name} → exit ${r.exitCode}`, r.exitCode === 0 ? "success" : "error");
    },
  });

  const del = useApiMutation({
    mutationFn: () => deleteSavedCommand(cmd.id),
    successToast: `Deleted "${cmd.name}"`,
    invalidateKeys: [["savedCommands"]],
  });

  return (
    <li className={`${CARD_CLASS} p-3`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            <span className="truncate">{cmd.name}</span>
            <Badge tone={cmd.kind === "shell" ? "accent" : "neutral"}>{cmd.kind}</Badge>
          </div>
          {cmd.description && <div className="text-xs text-gray-500">{cmd.description}</div>}
          <code className="mt-0.5 block truncate font-mono text-xs text-gray-400">
            {cmd.kind === "shell" ? cmd.command : `${cmd.command} ${cmd.args.join(" ")}`.trim()}
          </code>
          <div className="mt-0.5">
            <RunStatLine runCount={cmd.runCount} lastRunAt={cmd.lastRunAt} />
          </div>
          <CommandTagChips tags={cmd.tags} />
        </div>
        <Tooltip multiline content="Runs this saved command now on the server (the shell command, or the registry command with its preset args) and shows the latest exit code + output inline. Each run is recorded in its history.">
          <button type="button" onClick={() => run.mutate()} disabled={run.isPending} className={BTN_GHOST_CLASS}>
            <IconPlay size={14} /> {run.isPending ? "Running…" : "Run"}
          </button>
        </Tooltip>
        <button type="button" onClick={() => onEdit(cmd)} className={`${BTN_GHOST_CLASS} px-2`}>
          Edit
        </button>
        <Tooltip content="Delete">
          <button
            type="button"
            onClick={async () => {
              if (await confirm({ prompt: "Delete this command?", confirmText: "Delete" })) del.mutate();
            }}
            disabled={del.isPending}
            aria-label="Delete"
            className={`${BTN_GHOST_CLASS} px-2`}
          >
            <IconTrash size={14} />
          </button>
        </Tooltip>
      </div>

      {result && (
        <div className="mt-2">
          <div className="flex items-center gap-2 text-xs">
            <Badge tone={result.exitCode === 0 ? "success" : "error"}>exit {result.exitCode}</Badge>
            <span className="text-gray-400">{result.durationMs}ms</span>
          </div>
          {result.output.trim() && (
            <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-gray-800/60">
              {result.output}
            </pre>
          )}
          {result.reportPath && <ReportLinks reportPath={result.reportPath} className="mt-2" />}
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowHistory((v) => !v)}
        className="mt-2 text-xs text-gray-500 hover:text-accent"
      >
        {showHistory ? "▾ Hide history" : "▸ History"}
      </button>
      {showHistory && (
        <div className="mt-2">
          <RunHistory command={cmd.name} />
        </div>
      )}
    </li>
  );
}

/**
 * A built-in registry command in the list: a clickable card that deep-links to the
 * command's detail page (`/commands/:name`), with a corner Run shortcut that opens
 * the run modal without leaving the list (mirrors the Apps list's card + ↗ action).
 */
function BuiltinCommandRow({ cmd, onRun }: { cmd: Command; onRun: (c: Command) => void }) {
  return (
    <li className="relative">
      <Link
        to={`/commands/${encodeURIComponent(cmd.name)}`}
        className={`${CARD_INTERACTIVE_CLASS} block w-full cursor-pointer p-3 pr-24 text-left`}
      >
        <div className="font-medium">
          {cmd.name}
          <Badge tone="neutral" className="ml-2">
            {cmd.kind}
          </Badge>
        </div>
        <div className="text-xs text-gray-500">{cmd.description}</div>
        <div className="mt-0.5">
          <RunStatLine runCount={cmd.runCount} lastRunAt={cmd.lastRunAt} />
        </div>
        <CommandTagChips tags={cmd.tags} />
      </Link>
      {/* Sibling (not nested) so it's valid HTML; sits over the card's top-right. */}
      <button type="button" onClick={() => onRun(cmd)} className={`${BTN_GHOST_CLASS} absolute right-2 top-2`}>
        <IconPlay size={14} /> Run…
      </button>
    </li>
  );
}

export function CommandsPage() {
  const { data: commands = [] } = useQuery({ queryKey: ["commands"], queryFn: fetchCommands });
  const { data: saved = [] } = useQuery({ queryKey: ["savedCommands"], queryFn: fetchSavedCommands });
  const [q, setQ] = useState("");
  const [sort, setSort] = usePersistedSort();
  const [running, setRunning] = useState<Command | null>(null);
  const [editing, setEditing] = useState<SavedCommand | null>(null);
  const [creating, setCreating] = useState(false);

  const sortedSaved = sortCommands(saved, sort);
  const filtered = sortCommands(
    commands.filter((c: Command) => `${c.name} ${c.description}`.toLowerCase().includes(q.toLowerCase())),
    sort,
  );

  return (
    <div>
      <PageHeading title="Commands" count={commands.length} />

      <div className="mb-4 flex items-center justify-end gap-2">
        <label htmlFor="cmd-sort" className="text-xs text-gray-500 dark:text-gray-400">
          Sort
        </label>
        <select
          id="cmd-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-300">
            Saved commands
            <span className="ml-2 text-xs font-normal text-gray-400">{saved.length}</span>
          </h3>
          <Tooltip multiline content="Creates a new saved command — an arbitrary shell command (with an optional working dir), or a registry command with preset args. Saved commands are re-runnable from here and keep a full run history.">
            <button type="button" onClick={() => setCreating(true)} className={BTN_PRIMARY_CLASS}>
              <IconPlus size={14} /> New
            </button>
          </Tooltip>
        </div>
        {saved.length === 0 ? (
          <p className="text-xs text-gray-400">
            None yet. Save an arbitrary shell command, or a registry command with preset args — runs are recorded with
            full history.
          </p>
        ) : (
          <ul className="space-y-2">
            {sortedSaved.map((c) => (
              <SavedCommandCard key={c.id} cmd={c} onEdit={setEditing} />
            ))}
          </ul>
        )}
      </section>

      <h3 className="mb-2 text-sm font-semibold text-gray-600 dark:text-gray-300">Built-in</h3>
      <p className="mb-3 text-xs text-gray-400">
        Click a command for its flags, examples, history, and source — or Run… it right here.
      </p>
      <SearchInput value={q} onChange={setQ} />
      <ul className="space-y-2">
        {filtered.map((c) => (
          <BuiltinCommandRow key={c.name} cmd={c} onRun={setRunning} />
        ))}
      </ul>

      {running && <RunCommandModal command={running} onClose={() => setRunning(null)} />}
      {creating && <SavedCommandModal onClose={() => setCreating(false)} />}
      {editing && <SavedCommandModal initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---- Detail page -------------------------------------------------------------

/**
 * Deep-linkable per-command detail view (`/commands/:name`) — the command analogue
 * of the Apps detail page. Reads the command from the (already-cached, when arriving
 * from the list) `["commands"]` registry query, so a cold deep-link refetches the
 * registry and resolves the name itself. Shows the synopsis, arguments, flags,
 * examples, the live script source, run history, and the raw registry entry.
 */
export function CommandDetailPage() {
  const { name = "" } = useParams();
  const { data: commands = [], isLoading } = useQuery({ queryKey: ["commands"], queryFn: fetchCommands });
  const command = commands.find((c) => c.name === name);

  return (
    <div className="mx-auto max-w-3xl">
      {!command ? (
        isLoading ? (
          <p className="text-gray-400">loading…</p>
        ) : (
          <p className="text-gray-400">
            No command named <span className="font-mono">{name}</span>.
          </p>
        )
      ) : (
        <CommandDetailBody command={command} />
      )}
    </div>
  );
}

/** `name <required> [optional] [flags]` — a one-line usage summary. */
function synopsis(cmd: Command): string {
  const parts = [cmd.name];
  for (const a of cmd.args ?? []) parts.push(a.required ? `<${a.name}>` : `[${a.name}]`);
  if ((cmd.flags ?? []).length > 0) parts.push("[flags]");
  return parts.join(" ");
}

function CommandDetailBody({ command }: { command: Command }) {
  const [running, setRunning] = useState(false);
  const usage = synopsis(command);
  const json = JSON.stringify(command, null, 2);
  const args = command.args ?? [];
  const flags = command.flags ?? [];
  const examples = command.examples ?? [];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{command.kind}</Badge>
            {command.capture === false && <Badge tone="neutral">no capture</Badge>}
          </div>
          {command.description && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{command.description}</p>}
        </div>
        <button type="button" onClick={() => setRunning(true)} className={BTN_PRIMARY_CLASS}>
          <IconPlay size={14} /> Run…
        </button>
      </div>

      <div className="space-y-5">
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <SectionHeading>Usage</SectionHeading>
            <span className="ml-auto">
              <CopyButton text={usage} />
            </span>
          </div>
          <code className="block overflow-auto rounded-lg bg-gray-100 px-3 py-2 font-mono text-sm dark:bg-gray-800/60">
            {usage}
          </code>
          {command.kind === "cd" && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
              A <span className="font-mono">cd</span> command — its stdout is a path the shell cd's into; running it
              from the web just prints that path.
            </p>
          )}
          {command.script && (
            <p className="mt-1.5 font-mono text-xs text-gray-400">
              {command.script}
              {command.scriptPath && <OpenPathButton path={command.scriptPath} />}
            </p>
          )}
        </section>

        {args.length > 0 && (
          <section>
            <SectionHeading>Arguments</SectionHeading>
            <ul className="space-y-1.5">
              {args.map((a) => (
                <li key={a.name} className="text-sm">
                  <span className="font-mono font-medium">{a.name}</span>
                  {a.required && <span className="text-red-500"> *</span>}
                  <span className="ml-2 text-gray-500 dark:text-gray-400">{a.description}</span>
                  {a.example && <span className="ml-2 font-mono text-xs text-gray-400">e.g. {a.example}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {flags.length > 0 && (
          <section>
            <SectionHeading>Flags</SectionHeading>
            <ul className="space-y-1.5">
              {flags.map((f) => (
                <li key={f.flag} className="text-sm">
                  <span className="font-mono font-medium">{f.flag}</span>
                  {f.takesValue && <span className="ml-1 font-mono text-xs text-gray-400">&lt;value&gt;</span>}
                  <span className="ml-2 text-gray-500 dark:text-gray-400">{f.description}</span>
                  {f.example && <span className="ml-2 font-mono text-xs text-gray-400">e.g. {f.example}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {examples.length > 0 && (
          <section>
            <SectionHeading>Examples</SectionHeading>
            <div className="space-y-1.5">
              {examples.map((ex) => {
                const line = `${command.name} ${ex.args}`.trim();
                return (
                  <div key={ex.args} className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
                      {line}
                      {ex.note && <span className="ml-2 text-gray-400">— {ex.note}</span>}
                    </code>
                    <CopyButton text={line} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <CommandSourceSection command={command} />

        <section>
          <SectionHeading>History</SectionHeading>
          <RunHistory command={command.name} />
        </section>

        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <SectionHeading>Registry entry</SectionHeading>
            <span className="ml-auto">
              <CopyButton text={json} />
            </span>
          </div>
          <CodeBlock code={json} lang="json" />
        </section>
      </div>

      {running && <RunCommandModal command={command} onClose={() => setRunning(false)} />}
    </>
  );
}

/** The on-disk script backing the command — best-effort (a failure just hides it). */
function CommandSourceSection({ command }: { command: Command }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["command-source", command.name],
    queryFn: () => fetchCommandSource(command.name),
  });
  if (isError) return null;
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading>
          <span className="inline-flex items-center gap-1.5">
            <IconFileText size={13} /> Script
          </span>
        </SectionHeading>
        {data && (
          <span className="ml-auto">
            <CopyButton text={data.source} />
          </span>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-gray-400">loading source…</p>
      ) : data ? (
        <CodeBlock code={data.source} lang="typescript" />
      ) : null}
    </section>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{children}</h4>;
}

/** Syntax-highlighted code via a fenced markdown block (matches the Apps detail page). */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="overflow-auto rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      <ReactMarkdown
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: (props: ComponentPropsWithoutRef<"pre">) => <pre className="m-0 font-mono text-xs" {...props} />,
        }}
      >
        {`\`\`\`${lang}\n${code}\n\`\`\``}
      </ReactMarkdown>
    </div>
  );
}
