import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DisclosureButton, EnvEditor } from "cursedbelt/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  type AppConfig,
  type AppDetails,
  type AppDiffAction,
  type AppGitAction,
  type AppLink,
  type AppSources,
  type AppTag,
  type BranchAction,
  browseDir,
  type BrowseDirResult,
  cloneApp,
  type Command,
  createAppTag,
  DB_SUGGESTIONS,
  deleteApp,
  detectAppTech,
  type DiffBase,
  fetchAppBranches,
  fetchAppEnvFile,
  fetchAppEnvFiles,
  fetchAppCommitFileDiff,
  fetchAppCommitFiles,
  fetchAppCommitFullDiff,
  fetchAppDeploy,
  fetchAppDetails,
  fetchAppDiff,
  fetchAppFileDiff,
  fetchAppFullDiff,
  fetchAppJenkins,
  fetchAppLog,
  fetchAppOpenshift,
  fetchApps,
  fetchConfig,
  fetchCommands,
  fetchAppStashes,
  fetchAppStashFileDiff,
  fetchAppStashFiles,
  fetchAppStashFullDiff,
  fetchAppTags,
  fillGitUrls,
  openApp,
  openAppPr,
  type OpenPrResult,
  refreshApp,
  runAppBranch,
  runAppDiff,
  runAppGit,
  runAppStash,
  runAppTag,
  saveAppDb,
  saveAppEnvFile,
  saveAppLinks,
  saveAppTechTags,
  type ScanResult,
  runAppsScan,
  setCodeDirs,
  type StashAction,
  type StashDiffMode,
  type StashEntry,
  type TagAction,
} from "../api";
import {
  Alert,
  Badge,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  CARD_INTERACTIVE_CLASS,
  FIELD_CLASS,
  OpenPathButton,
  PageHeading,
  SearchInput,
  Tooltip,
} from "../components";
import { IconExternal, IconPlus, IconTrash } from "../icons";
import { DiffBrowser } from "../DiffBrowser";
import { Modal } from "../Modal";
import { RunCommandModal } from "../RunCommandModal";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { CopyButton } from "./tools/toolkit";

/** Infer the VCS host tag from a clone URL (github/gitlab/bitbucket). */
function vcsHost(url?: string): string | undefined {
  if (!url) return undefined;
  const u = url.toLowerCase();
  if (u.includes("github")) return "github";
  if (u.includes("gitlab")) return "gitlab";
  if (u.includes("bitbucket")) return "bitbucket";
  return undefined;
}

/**
 * The tech tags shown for an app: db ∪ apis names ∪ cloneUrl host ∪ manual tags,
 * deduped + lowercased + sorted. Mirrors the server's `effectiveAppTags` so the
 * card, the detail overview, and the editor all agree.
 */
function effectiveAppTags(app: AppConfig): string[] {
  const tags = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) tags.add(v.trim().toLowerCase());
  };
  for (const d of app.db ?? []) add(d);
  for (const api of app.apis ?? []) add(api?.name);
  add(vcsHost(app.cloneUrl));
  for (const t of app.tags ?? []) add(t);
  return [...tags].sort();
}

/**
 * One-click "open this app in your editor" — runs `gotab`'s mechanism on the
 * server (POST /api/apps/:name/open). Stops click propagation so the card-corner
 * variant doesn't also navigate to the app's detail page.
 */
function OpenInEditorButton({
  appName,
  className,
  children,
}: {
  appName: string;
  className?: string;
  children?: ReactNode;
}) {
  const { notify } = useToast();
  const open = useMutation({
    mutationFn: () => openApp(appName),
    onSuccess: (r) => notify(`Opening ${appName} in ${r.editor}`, "success"),
    onError: (e) => notify(e instanceof Error ? e.message : "open failed", "error"),
  });
  return (
    <Tooltip content="Open in editor">
    <button
      type="button"
      aria-label={`Open ${appName} in editor`}
      disabled={open.isPending}
      onClick={(e) => {
        e.stopPropagation();
        open.mutate();
      }}
      className={className}
    >
      {children ?? <IconExternal size={14} />}
    </button>
    </Tooltip>
  );
}

/**
 * Unregister an app — removes its entry from apps.json (the files on disk are left
 * untouched). Confirms first via the shared cwip dialog, then invalidates the
 * registry and navigates back to the apps list. Shown on the app's detail page.
 */
function RemoveAppButton({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { notify } = useToast();
  const confirm = useConfirm();

  const remove = useMutation({
    mutationFn: () => deleteApp(app.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      notify(`Removed "${app.name}" from the registry`, "success");
      nav("/");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "remove failed", "error"),
  });

  const onClick = async () => {
    const ok = await confirm({
      prompt: `Remove "${app.name}" from the registry?`,
      flavorText: "This only unregisters the app (removes it from apps.json). Files on disk are left untouched.",
      confirmText: "Remove",
    });
    if (ok) remove.mutate();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={remove.isPending}
      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
    >
      <IconTrash size={14} /> {remove.isPending ? "Removing…" : "Remove"}
    </button>
  );
}

function haystack(a: AppConfig): string {
  return [a.name, a.group, a.dirName, ...(a.aliases ?? [])].join(" ").toLowerCase();
}

/**
 * The group's own directory — the app's parent dir. `group` is the parent path
 * relative to the scan root, so the app lives at `<scanRoot>/<group>/<dirName>`
 * and the group folder is simply the app's parent dir. Opening it in the editor
 * surfaces every sibling app/file in that group at once (what `gotab <dir>` does).
 */
function groupDir(absolutePath: string): string {
  return absolutePath.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
}

/** Render a ScanResult summary as a human-readable toast message. */
function scanSummary(res: ScanResult): string {
  const parts: string[] = [];
  if (res.newApps.length) parts.push(`${res.newApps.length} new`);
  if (res.updatedCount) parts.push(`${res.updatedCount} updated`);
  if (res.missingApps.length) parts.push(`${res.missingApps.length} missing`);
  if (res.removedCount) parts.push(`${res.removedCount} removed`);
  if (res.pinnedCount) parts.push(`${res.pinnedCount} pinned`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return `Scanned ${res.reposFound} repos${detail}`;
}

/**
 * Folder-picker modal: navigate the filesystem, add a directory to codeDirs,
 * and optionally kick off a full recursive rubato-scan immediately.
 */
function FolderPickerModal({
  onClose,
  codeDirs,
  onDirsChanged,
}: {
  onClose: () => void;
  codeDirs: string[];
  onDirsChanged: () => void;
}) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const [current, setCurrent] = useState<BrowseDirResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [pathInput, setPathInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);

  const load = async (path: string) => {
    setLoading(true);
    try {
      const result = await browseDir(path);
      setCurrent(result);
      setPathInput(result.path);
    } catch (e) {
      notify(e instanceof Error ? e.message : "could not read directory");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(""); }, []);

  const goUp = () => {
    if (!current) return;
    load(current.path.replace(/\/[^/]+$/, "") || "/");
  };

  const addDir = useMutation({
    mutationFn: async (andScan: boolean) => {
      const path = current?.path ?? "";
      const next = codeDirs.includes(path) ? codeDirs : [...codeDirs, path];
      await setCodeDirs(next);
      onDirsChanged();
      if (andScan) {
        const res = await runAppsScan();
        qc.invalidateQueries({ queryKey: ["apps"] });
        notify(scanSummary(res));
      } else {
        notify(`Added ${path} to scan roots`);
      }
      onClose();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "failed"),
  });

  const isHome = current ? current.path === current.home : false;
  const alreadyAdded = current ? codeDirs.includes(current.path) : false;

  return (
    <Modal title="Add a scan root" onClose={onClose} widthClass="max-w-xl">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-gray-500">
          Navigate to your code directory (e.g. <span className="font-mono">~/code</span>). rubato-scan
          will recursively find all git repos inside it and register them as apps.
        </p>

        {/* Navigation bar */}
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => load(current?.home ?? "")} disabled={loading || isHome} title="Home">~</button>
          <button type="button" className={BTN_GHOST_CLASS} onClick={goUp} disabled={loading || !current || current.path === "/"} title="Up">↑</button>
          <input
            className={`${FIELD_CLASS} flex-1 font-mono text-xs`}
            value={inputFocused ? pathInput : (current?.path ?? "")}
            onChange={(e) => setPathInput(e.target.value)}
            onFocus={() => { setInputFocused(true); setPathInput(current?.path ?? ""); }}
            onBlur={() => setInputFocused(false)}
            onKeyDown={(e) => { if (e.key === "Enter") { load(pathInput); setInputFocused(false); } }}
            placeholder="Type a path and press Enter"
            spellCheck={false}
          />
        </div>

        {/* Directory listing */}
        <div className="max-h-56 overflow-auto rounded border border-gray-200 dark:border-gray-700">
          {loading ? (
            <p className="p-3 text-xs text-gray-400">Loading…</p>
          ) : !current || current.dirs.length === 0 ? (
            <p className="p-3 text-xs text-gray-400">No subdirectories</p>
          ) : (
            <ul>
              {current.dirs.map((dir) => (
                <li key={dir}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                    onClick={() => load(`${current.path}/${dir}`)}
                  >
                    <span className="text-gray-400">📁</span>
                    <span className="font-mono">{dir}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
          <span className="flex-1 truncate font-mono text-xs text-gray-500">{current?.path ?? "…"}</span>
          {alreadyAdded && <span className="text-xs text-gray-400">already a scan root</span>}
          <Tooltip content="Save this directory as a scan root without running a scan yet">
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              disabled={addDir.isPending || !current || alreadyAdded}
              onClick={() => addDir.mutate(false)}
            >
              Add root
            </button>
          </Tooltip>
          <Tooltip content="Save as a scan root and immediately run rubato-scan to discover all git repos inside it">
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={addDir.isPending || !current}
              onClick={() => addDir.mutate(true)}
            >
              {addDir.isPending ? "Scanning…" : alreadyAdded ? "Scan now" : "Add + scan"}
            </button>
          </Tooltip>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Repo tools: clone a repo to a location (+ register it) and backfill missing git
 * clone URLs from each repo's origin. A collapsible panel above the app list.
 */
function RepoTools() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: cfg } = useQuery({ queryKey: ["config"], queryFn: fetchConfig });
  const codeDirs: string[] = Array.isArray((cfg as Record<string, unknown> | undefined)?.codeDirs)
    ? ((cfg as Record<string, unknown>).codeDirs as string[])
    : [];

  const clone = useMutation({
    mutationFn: () => cloneApp({ url: url.trim(), dest: dest.trim() }),
    onSuccess: (app) => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      setUrl("");
      setDest("");
      notify(`Cloned + registered "${app.name}"`);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "clone failed"),
  });

  const fill = useMutation({
    mutationFn: () => fillGitUrls(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      notify(res.count ? `Filled ${res.count} git URL(s)` : "All git URLs already set");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "fill failed"),
  });

  const scan = useMutation({
    mutationFn: () => runAppsScan(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      notify(scanSummary(res));
    },
    onError: (e) => notify(e instanceof Error ? e.message : "scan failed"),
  });

  return (
    <div className="mb-3">
      {pickerOpen && (
        <FolderPickerModal
          onClose={() => setPickerOpen(false)}
          codeDirs={codeDirs}
          onDirsChanged={() => qc.invalidateQueries({ queryKey: ["config"] })}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <DisclosureButton open={open} onToggle={() => setOpen((v) => !v)} className={BTN_GHOST_CLASS}>
          Repo tools
        </DisclosureButton>
        <Tooltip
          multiline
          content={`Recursively scans all configured scan roots (${codeDirs.length ? codeDirs.join(", ") : "none set"}) for git repos and merges them into the registry. Use "Add scan root…" to configure roots.`}
        >
          <button type="button" className={BTN_GHOST_CLASS} disabled={scan.isPending || codeDirs.length === 0} onClick={() => scan.mutate()}>
            {scan.isPending ? "Scanning…" : "Run scan"}
          </button>
        </Tooltip>
        <Tooltip content="Choose a directory to add as a scan root, then run the full recursive scan to discover all git repos inside it">
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => setPickerOpen(true)}>
            Add scan root…
          </button>
        </Tooltip>
        <Tooltip
          multiline
          content="Backfills the git clone URL for every registered repo that's missing one, reading it from each repo's `origin` remote. Safe to re-run — repos that already have a URL are left untouched, and it only updates apps.json metadata, never the repos themselves."
        >
          <button type="button" className={BTN_GHOST_CLASS} disabled={fill.isPending} onClick={() => fill.mutate()}>
            {fill.isPending ? "Filling…" : "Fill missing git URLs"}
          </button>
        </Tooltip>
      </div>
      {open && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() && dest.trim()) clone.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            Clone URL
            <input
              className={FIELD_CLASS}
              style={{ minWidth: 240 }}
              value={url}
              placeholder="git@… or https://…"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            Destination path
            <input
              className={FIELD_CLASS}
              style={{ minWidth: 240 }}
              value={dest}
              placeholder="~/code/new-repo"
              onChange={(e) => setDest(e.target.value)}
            />
          </label>
          <Tooltip
            multiline
            content="Clones the repository from the Clone URL into the Destination path on disk, then registers it in apps.json so it appears in this app list."
          >
            <button type="submit" className={BTN_PRIMARY_CLASS} disabled={clone.isPending || !url.trim() || !dest.trim()}>
              {clone.isPending ? "Cloning…" : "Clone + register"}
            </button>
          </Tooltip>
        </form>
      )}
    </div>
  );
}

export function AppsPage() {
  const { data = [], isLoading } = useQuery({ queryKey: ["apps"], queryFn: fetchApps });
  const [q, setQ] = useState("");
  const filtered = data.filter((a) => haystack(a).includes(q.toLowerCase()));

  return (
    <div>
      <PageHeading
        title="Apps"
        count={data.length}
        actions={
          <Link to="/apps/templates" className={BTN_GHOST_CLASS}>
            Templates
          </Link>
        }
      />
      <p className="mb-3 text-xs text-gray-400">
        Any named path you jump to or run commands against — usually a code repo, sometimes just a dir or a single file
        (e.g. <span className="font-mono">~/.zshrc</span>). Click a card for details, or the ↗ to open it in your editor.
        Manage a portable <Link to="/apps/templates" className="text-accent hover:underline">app template</Link> to share
        entries across machines.
      </p>
      <RepoTools />
      <SearchInput value={q} onChange={setQ} />
      {isLoading ? (
        <p className="text-gray-400">loading…</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((a) => (
            <li key={a.absolutePath} className="relative">
              <Link
                to={`/apps/${encodeURIComponent(a.name)}`}
                className={`${CARD_INTERACTIVE_CLASS} block w-full cursor-pointer p-3 pr-12 text-left`}
              >
                <div className="font-medium">
                  {a.name}
                  {a.group && <span className="ml-2 text-xs text-gray-400">/ {a.group}</span>}
                </div>
                <div className="my-1.5 flex flex-wrap gap-1">
                  {(a.aliases ?? []).map((x) => (
                    <Badge key={x} tone="neutral">
                      {x}
                    </Badge>
                  ))}
                  {effectiveAppTags(a).map((t) => (
                    <Badge key={t} tone="accent">
                      {t}
                    </Badge>
                  ))}
                </div>
                <div className="font-mono text-xs text-gray-500">{a.absolutePath}</div>
              </Link>
              {/* Sibling (not nested) so it's valid HTML; sits over the card's top-right. */}
              <OpenInEditorButton appName={a.name} className="icon-btn absolute right-2 top-2" />
            </li>
          ))}
          {filtered.length === 0 && <li className="text-gray-400">no matches</li>}
        </ul>
      )}
    </div>
  );
}

// ---- Detail page -------------------------------------------------------------

/**
 * Deep-linkable per-app detail view (`/apps/:name`). Replaces the old modal so an
 * app has its own URL — copyable, back/forward-navigable, refresh-safe. The app
 * config is read from the (already-cached, when arriving from the list) `["apps"]`
 * query, so a cold deep-link refetches the registry and resolves the name itself.
 */
export function AppDetailPage() {
  const { name = "" } = useParams();
  const { data: apps = [], isLoading } = useQuery({ queryKey: ["apps"], queryFn: fetchApps });
  const app = apps.find((a) => a.name === name);

  return (
    <div className="mx-auto max-w-3xl">
      {!app ? (
        isLoading ? (
          <p className="text-gray-400">loading…</p>
        ) : (
          <p className="text-gray-400">
            No app named <span className="font-mono">{name}</span>.
          </p>
        )
      ) : (
        <AppDetailBody app={app} />
      )}
    </div>
  );
}

function AppDetailBody({ app }: { app: AppConfig }) {
  const json = JSON.stringify(app, null, 2);
  // Live README + git status — best-effort, so a failure just hides those sections.
  const { data: details, isLoading } = useQuery({
    queryKey: ["app-details", app.name],
    queryFn: () => fetchAppDetails(app.name),
  });
  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-2xl font-bold tracking-tight">{app.name}</h2>
          {app.group && <div className="mt-1 text-sm text-gray-400">/ {app.group}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RefreshAllButton app={app} />
          <OpenInEditorButton appName={app.name} className={BTN_GHOST_CLASS}>
            <IconExternal size={14} /> Open in editor
          </OpenInEditorButton>
          <RemoveAppButton app={app} />
        </div>
      </div>

      <div className="space-y-5">
        <Overview app={app} />

        <TechTagsSection app={app} />

        <LinksSection app={app} />

        <EnvFilesSection app={app} />

        {details?.git && <GitSection git={details.git} />}

        {details?.git?.isRepo && <GitActionsSection app={app} />}

        {details?.git?.isRepo && <DiffSection app={app} />}

        {details?.git?.isRepo && <StashSection app={app} />}

        {details?.git?.isRepo && <TagsSection app={app} />}

        {details?.git?.isRepo && <LogSection app={app} />}

        {details?.git?.isRepo && <BranchesSection app={app} sources={details.sources} />}

        {details?.sources && <DeploymentSections app={app} sources={details.sources} />}

        {details?.sources && <CommandsSection app={app} sources={details.sources} />}

        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <SectionHeading>app.json</SectionHeading>
            <span className="ml-auto">
              <CopyButton text={json} />
            </span>
          </div>
          <JsonBlock json={json} />
        </section>

        {isLoading ? (
          <p className="text-xs text-gray-400">loading details…</p>
        ) : (
          details?.readme && <ReadmeSection readme={details.readme} />
        )}
      </div>
    </>
  );
}

/** Relative "Ns/m/h/d ago" for an epoch-ms timestamp. */
function timeAgo(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function buildTone(status: string, building: boolean): "success" | "error" | "neutral" | "accent" {
  if (building) return "accent";
  const s = status.toLowerCase();
  if (s.includes("success")) return "success";
  if (s.includes("fail")) return "error";
  return "neutral";
}

/** Short, readable image label (drop registry/digest, keep repo:tag tail). */
function shortImage(image?: string): string {
  if (!image) return "";
  const at = image.lastIndexOf("@");
  const base = at >= 0 ? image.slice(0, at) : image;
  return base.split("/").pop() ?? base;
}

/** A label/value pair for the deploy facts grid. */
function KvRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-gray-400">{label}</dt>
      <dd className={mono ? "font-mono" : ""}>{value ?? <span className="text-gray-400">—</span>}</dd>
    </>
  );
}

/** Env names an app exposes, from its Jenkins env configs + OpenShift per-env namespaces. */
function appEnvNames(app: AppConfig): string[] {
  const out = new Set<string>();
  const jenkins = app.apis?.find((a) => a.name === "jenkins") as { envs?: { envName?: string }[] } | undefined;
  for (const e of jenkins?.envs ?? []) if (e.envName) out.add(e.envName);
  const oc = app.apis?.find((a) => a.name === "openshift") as { namespaces?: Record<string, string> } | undefined;
  for (const k of Object.keys(oc?.namespaces ?? {})) out.add(k);
  return [...out];
}

/** Re-fetch every applicable per-app system after dropping the server's memo caches. */
function RefreshAllButton({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const refresh = useMutation({
    mutationFn: () => refreshApp(app.name),
    onSuccess: () => {
      for (const k of [
        ["app-details", app.name],
        ["app-jenkins", app.name],
        ["app-deploy", app.name],
        ["app-openshift", app.name],
        ["app-diff", app.name],
        ["app-stashes", app.name],
        ["app-tags", app.name],
        ["app-log", app.name],
        ["app-branches", app.name],
      ]) {
        qc.invalidateQueries({ queryKey: k });
      }
      notify("Refreshed app data", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "refresh failed", "error"),
  });
  return (
    <Tooltip
      multiline
      content="Re-fetches every data source for this app at once — git status/branches/log, uncommitted changes & stashes, tags, and the Jenkins / deploy / OpenShift panels — and updates them in place."
    >
      <button type="button" className={BTN_PRIMARY_CLASS} disabled={refresh.isPending} onClick={() => refresh.mutate()}>
        {refresh.isPending ? "Refreshing…" : "↻ Refresh all"}
      </button>
    </Tooltip>
  );
}

/** The deploy/runtime block: a shared env selector + Jenkins / Deploy / OpenShift sections. */
function DeploymentSections({ app, sources }: { app: AppConfig; sources: AppSources }) {
  const envs = appEnvNames(app);
  const [env, setEnv] = useState<string>(envs[0] ?? "");
  if (!sources.jenkins && !sources.quay && !sources.openshift) return null;
  return (
    <>
      {envs.length > 0 && (
        <div className="flex items-center gap-2">
          <SectionHeading>Deployment &amp; runtime</SectionHeading>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-500">
            env
            <select
              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            >
              {envs.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {sources.jenkins && <JenkinsSection app={app} env={env || undefined} />}
      {sources.quay && <DeploySection app={app} env={env || undefined} />}
      {sources.openshift && <OpenshiftSection app={app} env={env || undefined} />}
    </>
  );
}

/** Recent Jenkins builds for the app's job. */
function JenkinsSection({ app, env }: { app: AppConfig; env?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["app-jenkins", app.name, env ?? ""],
    queryFn: () => fetchAppJenkins(app.name, env),
  });
  return (
    <section>
      <SectionHeading>Jenkins</SectionHeading>
      {isLoading ? (
        <p className="text-xs text-gray-400">loading builds…</p>
      ) : !data?.ok ? (
        <p className="text-xs text-gray-400">{data?.error ?? "No Jenkins data."}</p>
      ) : data.builds.length === 0 ? (
        <p className="text-xs text-gray-400">No builds.</p>
      ) : (
        <div className={`${CARD_CLASS} overflow-hidden`}>
          <table className="w-full text-xs">
            <tbody>
              {data.builds.map((b) => (
                <tr key={b.number} className="border-b border-gray-100 last:border-0 dark:border-gray-900">
                  <td className="px-2 py-1.5 font-mono">
                    <a href={b.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      #{b.number}
                    </a>
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge tone={buildTone(b.status, b.building)}>{b.building ? "building" : b.status}</Badge>
                  </td>
                  <td className="max-w-[160px] truncate px-2 py-1.5 font-mono text-gray-500">
                    <Tooltip content={b.branch ?? ""}>
                      <span>{b.branch ?? ""}</span>
                    </Tooltip>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-gray-400">{b.commit?.slice(0, 8) ?? ""}</td>
                  <td className="px-2 py-1.5 text-right text-gray-400">{timeAgo(b.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The deployed image (Quay version + sha) joined with the build that produced it. */
function DeploySection({ app, env }: { app: AppConfig; env?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["app-deploy", app.name, env ?? ""],
    queryFn: () => fetchAppDeploy(app.name, env),
  });
  return (
    <section>
      <SectionHeading>Deploy</SectionHeading>
      {isLoading ? (
        <p className="text-xs text-gray-400">loading…</p>
      ) : data?.configured === false ? (
        <div className={`${CARD_CLASS} p-3 text-sm text-gray-500`}>
          No deploy credentials configured — set Jenkins/Quay creds in <span className="font-mono">~/.rubato/.env</span>.
        </div>
      ) : (
        <div className={`${CARD_CLASS} p-3 text-sm`}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <KvRow label="version" value={data?.version} mono />
            <KvRow label="image sha" value={data?.imageSha?.slice(0, 16)} mono />
            <KvRow label="commit" value={data?.commit?.slice(0, 10)} mono />
            <KvRow label="build" value={data?.buildNumber != null ? `#${data.buildNumber}` : undefined} mono />
            <KvRow label="published" value={data?.publishedAt ? new Date(data.publishedAt).toLocaleString() : undefined} />
          </dl>
          {data?.error && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{data.error}</p>}
        </div>
      )}
    </section>
  );
}

/** OpenShift deployments + pod roll-up for the app's namespace. */
function OpenshiftSection({ app, env }: { app: AppConfig; env?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["app-openshift", app.name, env ?? ""],
    queryFn: () => fetchAppOpenshift(app.name, env),
  });
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading>OpenShift</SectionHeading>
        {data?.namespace && <span className="font-mono text-xs text-gray-400">{data.namespace}</span>}
      </div>
      {isLoading ? (
        <p className="text-xs text-gray-400">loading…</p>
      ) : !data?.ok ? (
        <p className="text-xs text-gray-400">{data?.error ?? "No OpenShift data."}</p>
      ) : (
        <div className="space-y-2">
          {data.pods && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone="success">{data.pods.running} running</Badge>
              {data.pods.failed > 0 && <Badge tone="error">{data.pods.failed} failed</Badge>}
              {data.pods.notReady > 0 && <Badge tone="neutral">{data.pods.notReady} not ready</Badge>}
              {data.pods.restarts > 0 && <Badge tone="neutral">{data.pods.restarts} restarts</Badge>}
            </div>
          )}
          {data.deployments.length === 0 ? (
            <p className="text-xs text-gray-400">No deployments.</p>
          ) : (
            <div className={`${CARD_CLASS} overflow-hidden`}>
              <table className="w-full text-xs">
                <tbody>
                  {data.deployments.map((d) => (
                    <tr key={d.name} className="border-b border-gray-100 last:border-0 dark:border-gray-900">
                      <td className="px-2 py-1.5 font-medium">{d.name}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={d.isAvailable ? "success" : "error"}>
                          {d.ready}/{d.replicas}
                        </Badge>
                      </td>
                      <td className="max-w-[260px] truncate px-2 py-1.5 font-mono text-gray-400">
                        <Tooltip content={d.image}>
                          <span>{shortImage(d.image)}</span>
                        </Tooltip>
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-400">
                        {d.updatedAt ? timeAgo(Date.parse(d.updatedAt)) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.pods?.problematic?.length ? (
            <ul className="space-y-0.5 text-xs text-rose-500">
              {data.pods.problematic.map((p) => (
                <li key={p.name} className="font-mono">
                  {p.name}: {p.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * App-relevant commands, prefilled for this app: app-scoped registry commands
 * (those whose first arg is the app) open in the run form with the app locked, so
 * you just adjust flags and trigger. Plus quick "Deploy → <env>" buttons that open
 * the audited `deploy` command prefilled with app+env (tick --dry-run to preview,
 * --yes to actually trigger — required from the web).
 */
function CommandsSection({ app, sources }: { app: AppConfig; sources: AppSources }) {
  const { data: commands = [] } = useQuery({ queryKey: ["commands"], queryFn: fetchCommands });
  const [run, setRun] = useState<{ command: Command; prefill: Record<string, string>; lock: string[] } | null>(null);

  // App-scoped = the command's first positional arg references an app.
  const appCommands = commands.filter((c) => (c.args?.[0]?.name ?? "").toLowerCase().includes("app"));
  const deployCmd = commands.find((c) => c.name === "deploy");
  const envs = appEnvNames(app);

  const openFor = (command: Command, extra?: Record<string, string>) => {
    const prefill: Record<string, string> = {};
    const lock: string[] = [];
    const first = command.args?.[0]?.name;
    if (first) {
      prefill[first] = app.name;
      lock.push(first);
    }
    for (const [k, v] of Object.entries(extra ?? {})) {
      prefill[k] = v;
      lock.push(k);
    }
    setRun({ command, prefill, lock });
  };

  if (appCommands.length === 0) return null;
  return (
    <section>
      <SectionHeading>Commands</SectionHeading>
      {sources.jenkins && deployCmd && envs.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Deploy:</span>
          {envs.map((env) => (
            <button key={env} type="button" className={BTN_GHOST_CLASS} onClick={() => openFor(deployCmd, { env })}>
              → {env}
            </button>
          ))}
        </div>
      )}
      <div className={`${CARD_CLASS} divide-y divide-gray-100 dark:divide-gray-900`}>
        {appCommands.map((c) => (
          <div key={c.name} className="flex items-center gap-2 px-2 py-1.5 text-sm">
            <span className="font-mono">{c.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-500">{c.description}</span>
            <button type="button" className={BTN_GHOST_CLASS} onClick={() => openFor(c)}>
              Run…
            </button>
          </div>
        ))}
      </div>
      {run && (
        <RunCommandModal
          command={run.command}
          prefill={run.prefill}
          lockArgs={run.lock}
          onClose={() => setRun(null)}
        />
      )}
    </section>
  );
}

/** Recent commits; expand one to view its diff in the GitHub-style browser. */
function LogSection({ app }: { app: AppConfig }) {
  const { data, isLoading } = useQuery({ queryKey: ["app-log", app.name], queryFn: () => fetchAppLog(app.name) });
  const [openSha, setOpenSha] = useState<string | null>(null);
  const commits = data?.commits ?? [];
  return (
    <section>
      <SectionHeading>Commits</SectionHeading>
      {isLoading ? (
        <p className="text-xs text-gray-400">loading…</p>
      ) : !data?.ok ? (
        <p className="text-xs text-gray-400">{data?.error ?? "No log."}</p>
      ) : commits.length === 0 ? (
        <p className="text-xs text-gray-400">No commits.</p>
      ) : (
        <ul className={`${CARD_CLASS} divide-y divide-gray-100 dark:divide-gray-900`}>
          {commits.map((c) => (
            <li key={c.sha} className="px-2 py-1.5">
              <DisclosureButton
                open={openSha === c.sha}
                onToggle={() => setOpenSha(openSha === c.sha ? null : c.sha)}
                className="w-full text-sm"
                classNames={{ arrow: "text-gray-400" }}
              >
                <span className="font-mono text-xs text-accent">{c.shortSha}</span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                <span className="hidden shrink-0 text-xs text-gray-400 sm:inline">{c.author}</span>
                <span className="shrink-0 text-xs text-gray-400">{c.relativeDate}</span>
              </DisclosureButton>
              {openSha === c.sha && (
                <div className="mt-2">
                  <CommitDiff app={app} sha={c.sha} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A single commit's diff, browsed file-by-file or combined (reuses DiffBrowser). */
function CommitDiff({ app, sha }: { app: AppConfig; sha: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["app-commit-files", app.name, sha],
    queryFn: () => fetchAppCommitFiles(app.name, sha),
  });
  if (isLoading) return <p className="text-xs text-gray-400">loading…</p>;
  return (
    <DiffBrowser
      files={data?.files ?? []}
      fetchFileDiff={(f) => fetchAppCommitFileDiff(app.name, sha, f.path).then((r) => r.diff)}
      fileDiffKey={(f) => ["app-commit-file-diff", app.name, sha, f.path]}
      fetchFullDiff={() => fetchAppCommitFullDiff(app.name, sha).then((r) => r.diff)}
      fullDiffKey={["app-commit-full-diff", app.name, sha]}
      emptyText="No changes in this commit."
    />
  );
}

/** Local branches with tracking; checkout / create / delete / prune-gone. */
function BranchesSection({ app, sources }: { app: AppConfig; sources?: AppSources }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [newName, setNewName] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["app-branches", app.name], queryFn: () => fetchAppBranches(app.name) });
  const branches = data?.branches ?? [];
  const goneCount = branches.filter((b) => b.gone).length;

  const invalidate = () => {
    for (const k of [["app-branches", app.name], ["app-details", app.name], ["apps"]]) {
      qc.invalidateQueries({ queryKey: k });
    }
  };
  const act = useMutation({
    mutationFn: (body: { action: BranchAction; name?: string; from?: string }) => runAppBranch(app.name, body),
    onSuccess: (r, vars) => {
      invalidate();
      if (r.ok && vars.action === "create") setNewName("");
      const extra = r.branch ? ` · on ${r.branch}` : r.removed?.length ? ` · removed ${r.removed.length}` : "";
      notify(r.ok ? `${vars.action} ok${extra}` : `${vars.action} failed: ${r.error ?? "error"}`, r.ok ? "success" : "error");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "branch action failed", "error"),
  });

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading>Branches</SectionHeading>
        <span className="text-xs text-gray-400">{branches.length}</span>
        {goneCount > 0 && (
          <button
            type="button"
            className={`${BTN_GHOST_CLASS} ml-auto`}
            disabled={act.isPending}
            onClick={async () => {
              const ok = await confirm({
                prompt: `Delete ${goneCount} branch(es) whose upstream is gone?`,
                flavorText: "Runs git fetch --prune, then deletes local branches whose remote branch was deleted.",
                confirmText: "Prune gone",
              });
              if (ok) act.mutate({ action: "prune-gone" });
            }}
          >
            Prune gone ({goneCount})
          </button>
        )}
      </div>
      <div className="mb-2 flex items-center gap-2">
        <input
          className={FIELD_CLASS}
          style={{ maxWidth: 220 }}
          placeholder="new branch name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          className={BTN_GHOST_CLASS}
          disabled={!newName.trim() || act.isPending}
          onClick={() => act.mutate({ action: "create", name: newName.trim() })}
        >
          Create + switch
        </button>
        {(sources?.github || sources?.gitlab) && (
          <span className="ml-auto">
            <OpenPrButton app={app} />
          </span>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-gray-400">loading…</p>
      ) : !data?.ok ? (
        <p className="text-xs text-gray-400">{data?.error ?? "No branches."}</p>
      ) : (
        <ul className={`${CARD_CLASS} divide-y divide-gray-100 dark:divide-gray-900`}>
          {branches.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-sm">
              <span className={`font-mono ${b.current ? "font-semibold text-accent" : ""}`}>{b.name}</span>
              {b.current && <Badge tone="accent">current</Badge>}
              {b.gone && <Badge tone="error">gone</Badge>}
              {b.upstream && <span className="font-mono text-xs text-gray-400">→ {b.upstream}</span>}
              {(b.ahead > 0 || b.behind > 0) && (
                <span className="text-xs tabular-nums text-gray-400">
                  ↑{b.ahead} ↓{b.behind}
                </span>
              )}
              {!b.current && (
                <span className="ml-auto flex shrink-0 gap-1">
                  <button
                    type="button"
                    className={BTN_GHOST_CLASS}
                    disabled={act.isPending}
                    onClick={() => act.mutate({ action: "checkout", name: b.name })}
                  >
                    Checkout
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                    disabled={act.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        prompt: `Delete branch ${b.name}?`,
                        flavorText: "Force-deletes the local branch (git branch -D).",
                        confirmText: "Delete",
                      });
                      if (ok) act.mutate({ action: "delete", name: b.name });
                    }}
                  >
                    Delete
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Open a PR/MR from the current branch via the gh/glab CLI (branch must be pushed). */
function OpenPrButton({ app }: { app: AppConfig }) {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [result, setResult] = useState<OpenPrResult | null>(null);
  const create = useMutation({
    mutationFn: () => openAppPr(app.name, { title: title.trim() || undefined, base: base.trim() || undefined, draft }),
    onSuccess: (r) => {
      setResult(r);
      notify(r.ok ? "PR/MR opened" : (r.error ?? "PR failed"), r.ok ? "success" : "error");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "PR failed", "error"),
  });
  return (
    <>
      <button
        type="button"
        className={BTN_GHOST_CLASS}
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
      >
        Open PR…
      </button>
      {open && (
        <Modal title="Open a pull / merge request" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-xs text-gray-500">
              Creates a PR/MR from the current branch via the gh/glab CLI. Push the branch first if you haven't.
            </p>
            <input
              className={FIELD_CLASS}
              placeholder="title (optional — fills from commits)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              className={FIELD_CLASS}
              placeholder="base branch (optional)"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
            <label className="flex items-center gap-2 text-xs text-gray-500">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> draft
            </label>
            {result?.url && (
              <a href={result.url} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">
                {result.url}
              </a>
            )}
            {result && !result.ok && <p className="text-xs text-rose-500">{result.error}</p>}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" className={BTN_GHOST_CLASS} onClick={() => setOpen(false)}>
                Close
              </button>
              <button type="button" className={BTN_PRIMARY_CLASS} disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Opening…" : "Open PR"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{children}</h4>;
}

/**
 * Per-app shortcut links: click-to-open-in-new-tab chips plus an inline editor to
 * add/edit/remove { text, href } pairs (persisted to apps.json). Blank-href rows
 * are dropped on save (matching the server's normalizeAppLinks).
 */
function LinksSection({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AppLink[]>(app.links ?? []);

  const save = useMutation({
    mutationFn: () => saveAppLinks(app.name, draft.filter((l) => l.href.trim())),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["app-details", app.name] });
      setEditing(false);
      notify("Links saved");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Failed to save links"),
  });

  const links = app.links ?? [];

  if (!editing) {
    return (
      <section>
        <div className="mb-1.5 flex items-center gap-2">
          <SectionHeading>Links</SectionHeading>
          <button
            type="button"
            className={`${BTN_GHOST_CLASS} ml-auto`}
            onClick={() => {
              // From the empty state, drop straight into one blank row to fill in
              // (rather than an empty editor that only offers "+ Add link").
              setDraft(app.links?.length ? app.links : [{ text: "", href: "" }]);
              setEditing(true);
            }}
          >
            {links.length ? "Edit" : "Add links"}
          </button>
        </div>
        {links.length === 0 ? (
          <p className="text-xs text-gray-400">No links yet — add jenkins/quay/openshift/etc. shortcuts.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {links.map((l) => (
              <a
                key={`${l.text}-${l.href}`}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1 text-sm text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                <IconExternal size={13} />
                {l.text}
              </a>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <section>
      <SectionHeading>Links</SectionHeading>
      <div className="flex flex-col gap-2">
        {draft.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional + freely edited
          <div key={i} className="flex items-center gap-2">
            <input
              className={FIELD_CLASS}
              style={{ maxWidth: 160 }}
              value={l.text}
              placeholder="text"
              onChange={(e) =>
                setDraft(draft.map((d, idx) => (idx === i ? { ...d, text: e.target.value } : d)))
              }
            />
            <input
              className={FIELD_CLASS}
              value={l.href}
              placeholder="https://…"
              onChange={(e) =>
                setDraft(draft.map((d, idx) => (idx === i ? { ...d, href: e.target.value } : d)))
              }
            />
            <button
              type="button"
              aria-label="Remove link"
              className="rounded p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
              onClick={() => setDraft(draft.filter((_, idx) => idx !== i))}
            >
              <IconTrash size={15} />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={() => setDraft([...draft, { text: "", href: "" }])}
          >
            <IconPlus size={14} /> Add link
          </button>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              onClick={() => {
                setDraft(app.links ?? []);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className={BTN_PRIMARY_CLASS} disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save links"}
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}

/** Add/remove lowercase string chips with an input (+ optional datalist suggestions). */
function ChipListEditor({
  values,
  onChange,
  placeholder,
  suggestions,
  listId,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  suggestions?: string[];
  listId?: string;
}) {
  const [input, setInput] = useState("");
  const add = (raw: string) => {
    const v = raw.trim().toLowerCase();
    setInput("");
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
  };
  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800"
            >
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                className="text-gray-400 hover:text-rose-500"
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          className={FIELD_CLASS}
          style={{ maxWidth: 220 }}
          value={input}
          placeholder={placeholder}
          list={listId}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(input);
            }
          }}
        />
        <button type="button" className={BTN_GHOST_CLASS} onClick={() => add(input)}>
          <IconPlus size={14} /> Add
        </button>
      </div>
      {suggestions && listId && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/**
 * Edit an app's tech tags — its `db` list (with a "Detect from package.json"
 * seed + common-db suggestions) and free-form `tags`. The read view shows the
 * effective tag set (db ∪ apis ∪ git host ∪ tags). Mirrors the LinksSection flow.
 */
function TechTagsSection({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const [editing, setEditing] = useState(false);
  const [db, setDb] = useState<string[]>(app.db ?? []);
  const [tags, setTags] = useState<string[]>(app.tags ?? []);

  const effective = effectiveAppTags(app);

  const detect = useMutation({
    mutationFn: () => detectAppTech(app.name),
    onSuccess: (res) => {
      const added = res.dbs.filter((d) => !db.includes(d));
      if (added.length) setDb([...db, ...added]);
      notify(res.dbs.length ? `Detected: ${res.dbs.join(", ")}` : "No databases detected from package.json");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Detect failed"),
  });

  const save = useMutation({
    mutationFn: async () => {
      await saveAppDb(app.name, db);
      await saveAppTechTags(app.name, tags);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["app-details", app.name] });
      setEditing(false);
      notify("Tags saved");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Failed to save tags"),
  });

  const startEdit = () => {
    setDb(app.db ?? []);
    setTags(app.tags ?? []);
    setEditing(true);
  };

  if (!editing) {
    return (
      <section>
        <div className="mb-1.5 flex items-center gap-2">
          <SectionHeading>Tech tags</SectionHeading>
          <button type="button" className={`${BTN_GHOST_CLASS} ml-auto`} onClick={startEdit}>
            {effective.length ? "Edit" : "Add tags"}
          </button>
        </div>
        {effective.length === 0 ? (
          <p className="text-xs text-gray-400">
            No tags yet — add the databases (try Detect) and services this app involves.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {effective.map((t) => (
              <Badge key={t} tone="accent">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <section>
      <SectionHeading>Tech tags</SectionHeading>
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500">Databases</span>
            <button
              type="button"
              className={`${BTN_GHOST_CLASS} ml-auto`}
              disabled={detect.isPending}
              onClick={() => detect.mutate()}
            >
              {detect.isPending ? "Detecting…" : "Detect from package.json"}
            </button>
          </div>
          <ChipListEditor
            values={db}
            onChange={setDb}
            placeholder="mongodb, postgres…"
            suggestions={DB_SUGGESTIONS}
            listId={`db-sugg-${app.name}`}
          />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Other tags</span>
          <ChipListEditor values={tags} onChange={setTags} placeholder="harness, rancher…" />
        </div>
        <div className="flex items-center gap-2">
          <p className="text-xs text-gray-400">
            db + services + git host + these tags form the app's chips. Edit apps.json directly via Docs → System
            Files for full control.
          </p>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              onClick={() => {
                setDb(app.db ?? []);
                setTags(app.tags ?? []);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className={BTN_PRIMARY_CLASS} disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save tags"}
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Edit an app's .env files in place: pick a discovered `.env*` file, edit it in the
 * masked env editor (values hidden by default, eye to reveal, keys sortable), and
 * save back to disk. Uses cwip's EnvEditor so it matches the cursedalchemy tool.
 */
function EnvFilesSection({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data: files = [] } = useQuery({
    queryKey: ["app-env-files", app.name],
    queryFn: () => fetchAppEnvFiles(app.name),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");

  const fileQuery = useQuery({
    queryKey: ["app-env-file", app.name, selected],
    queryFn: () => fetchAppEnvFile(app.name, selected as string),
    enabled: !!selected,
  });

  useEffect(() => {
    if (fileQuery.data) {
      setDraft(fileQuery.data.content);
      setOriginal(fileQuery.data.content);
    }
  }, [fileQuery.data]);

  const save = useMutation({
    mutationFn: () => saveAppEnvFile(app.name, selected as string, draft),
    onSuccess: () => {
      setOriginal(draft);
      qc.invalidateQueries({ queryKey: ["app-env-files", app.name] });
      notify(`Saved ${selected}`);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Failed to save"),
  });

  const dirty = draft !== original;

  return (
    <section>
      <SectionHeading>Env files</SectionHeading>
      {files.length === 0 ? (
        <p className="text-xs text-gray-400">No .env files found in this app.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              className={`rounded-lg border px-2.5 py-1 font-mono text-xs ${
                selected === f.path
                  ? "border-accent bg-accent/10"
                  : "border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
              }`}
              onClick={() => setSelected(f.path)}
            >
              {f.path}
            </button>
          ))}
        </div>
      )}
      {selected &&
        (fileQuery.isLoading ? (
          <p className="mt-3 text-xs text-gray-400">loading…</p>
        ) : (
          <div className="mt-3">
            <EnvEditor value={draft} onChange={setDraft} onCopied={() => notify("Copied")} />
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" className={BTN_GHOST_CLASS} disabled={!dirty} onClick={() => setDraft(original)}>
                Discard
              </button>
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save to disk"}
              </button>
            </div>
          </div>
        ))}
    </section>
  );
}

/** Working-tree git state: branch, ahead/behind, and changed files. */
function GitSection({ git }: { git: NonNullable<AppDetails["git"]> }) {
  if (!git.isRepo) return null;
  return (
    <section>
      <SectionHeading>Git</SectionHeading>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {git.branch && (
          <Badge tone="accent">
            <span className="font-mono">{git.branch}</span>
          </Badge>
        )}
        {git.ahead ? <Badge tone="neutral">↑{git.ahead}</Badge> : null}
        {git.behind ? <Badge tone="neutral">↓{git.behind}</Badge> : null}
        <span className="text-xs text-gray-500">
          {git.entries.length === 0 ? "clean" : `${git.entries.length} changed`}
        </span>
      </div>
      {git.entries.length > 0 && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-gray-100 p-2 font-mono text-xs dark:bg-gray-800/60">
          {git.entries.join("\n")}
        </pre>
      )}
    </section>
  );
}

/**
 * Per-app git quick-actions for the "updating dozens of apps" workflow: commit
 * uncommitted work, checkout the default branch, and refresh from origin. Each
 * runs server-side via cwip git helpers; on success the git status + registry
 * refetch so the page reflects the new branch/clean state.
 */
function GitActionsSection({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<AppGitAction | null>(null);

  const run = useMutation({
    mutationFn: (action: AppGitAction) => runAppGit(app.name, action, message),
    onMutate: (action) => setBusy(action),
    onSettled: () => setBusy(null),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["app-details", app.name] });
      qc.invalidateQueries({ queryKey: ["apps"] });
      if (res.ok) {
        notify(`${res.action} ok${res.branch ? ` · on ${res.branch}` : ""}`);
        if (res.action === "commitAll") setMessage("");
      } else {
        notify(`${res.action} failed: ${res.error ?? "unknown error"}`);
      }
    },
    onError: (e) => notify(e instanceof Error ? e.message : "git action failed"),
  });

  const label = (a: AppGitAction, text: string) => (busy === a ? "…" : text);

  return (
    <section>
      <SectionHeading>Git actions</SectionHeading>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={FIELD_CLASS}
            style={{ maxWidth: 220 }}
            value={message}
            placeholder="commit message (optional)"
            onChange={(e) => setMessage(e.target.value)}
          />
          <Tooltip
            multiline
            content="Stages and commits every uncommitted change in this repo as a single commit, using the message on the left (or a default if it's blank)."
          >
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={run.isPending}
              onClick={() => run.mutate("commitAll")}
            >
              {label("commitAll", "Commit all")}
            </button>
          </Tooltip>
        </div>
        <div className="flex flex-wrap gap-2">
          <Tooltip multiline content="Switches this repo to its default branch (main/master).">
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              disabled={run.isPending}
              onClick={() => run.mutate("checkoutDefault")}
            >
              {label("checkoutDefault", "Checkout default branch")}
            </button>
          </Tooltip>
          <Tooltip
            multiline
            content="Fast-forward pulls the latest commits from origin on the current branch. It won't create a merge commit, so it fails rather than merging if the branch has diverged."
          >
            <button type="button" className={BTN_GHOST_CLASS} disabled={run.isPending} onClick={() => run.mutate("pull")}>
              {label("pull", "Pull (ff)")}
            </button>
          </Tooltip>
          <Tooltip
            multiline
            content="Fetches all updates from origin and prunes local remote-tracking branches whose upstream branch was deleted."
          >
            <button type="button" className={BTN_GHOST_CLASS} disabled={run.isPending} onClick={() => run.mutate("fetch")}>
              {label("fetch", "Fetch + prune")}
            </button>
          </Tooltip>
          <Tooltip
            multiline
            content="Pushes the current branch to origin (setting the upstream on the first push). A remote operation — it updates the remote repo, and asks for confirmation first."
          >
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              disabled={run.isPending}
              onClick={async () => {
                const ok = await confirm({
                  prompt: `Push the current branch of ${app.name} to origin?`,
                  flavorText: "Pushes the current branch (sets the upstream on first push). This is a remote operation.",
                  confirmText: "Push",
                });
                if (ok) run.mutate("push");
              }}
            >
              {label("push", "Push")}
            </button>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}

/**
 * Changes viewer: pick a base (uncommitted vs the last commit, or vs the local /
 * remote default branch), then browse a full combined diff or step file-by-file —
 * with stash-all / discard-all / discard-one for the uncommitted (head) base.
 */
function DiffSection({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [base, setBase] = useState<DiffBase>("head");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["app-diff", app.name, base],
    queryFn: () => fetchAppDiff(app.name, base),
  });
  const files = data?.files ?? [];
  const def = data?.defaultBranch ?? "main";

  const invalidate = () => {
    for (const k of [
      ["app-diff", app.name],
      ["app-full-diff", app.name],
      ["app-file-diff", app.name],
      ["app-details", app.name],
      ["apps"],
      ["app-stashes", app.name],
    ]) {
      qc.invalidateQueries({ queryKey: k });
    }
  };

  const act = useMutation({
    mutationFn: ({ action, paths, message }: { action: AppDiffAction; paths?: string[]; message?: string }) =>
      runAppDiff(app.name, action, paths, message),
    onSuccess: (res, vars) => {
      invalidate();
      if (res.ok && vars.action === "commit") {
        setSelected(new Set());
        setCommitMsg("");
      }
      notify(res.ok ? `${vars.action} ok` : `${vars.action} failed: ${res.error ?? "error"}`, res.ok ? "success" : "error");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "diff action failed", "error"),
  });

  const toggleSelect = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const selectionToolbar =
    base === "head" && selected.size > 0 ? (
      <span className="flex items-center gap-1.5">
        <input
          className={FIELD_CLASS}
          style={{ maxWidth: 200 }}
          placeholder="commit message"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
        />
        <button
          type="button"
          className={BTN_PRIMARY_CLASS}
          disabled={act.isPending || !commitMsg.trim()}
          onClick={() => act.mutate({ action: "commit", paths: [...selected], message: commitMsg })}
        >
          Commit {selected.size}
        </button>
      </span>
    ) : null;
  const discardAll = async () => {
    const ok = await confirm({
      prompt: `Discard ALL uncommitted changes in ${app.name}?`,
      flavorText: "This cannot be undone.",
      confirmText: "Discard all",
    });
    if (ok) act.mutate({ action: "discardAll" });
  };

  const baseOptions: { value: DiffBase; label: string }[] = [
    { value: "head", label: "Uncommitted (vs last commit)" },
    { value: "main", label: `vs ${def}` },
    ...(data?.hasOriginDefault ? [{ value: "origin-main" as DiffBase, label: `vs origin/${def}` }] : []),
  ];

  return (
    <section>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <SectionHeading>Changes</SectionHeading>
        <select
          className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
          value={base}
          onChange={(e) => setBase(e.target.value as DiffBase)}
          title="What to diff the working tree against"
        >
          {baseOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {base === "head" && files.length > 0 && (
          <span className="ml-auto flex gap-2">
            <Tooltip
              multiline
              content="Stashes every uncommitted change here onto the git stash (recoverable), leaving a clean working tree. Bring them back later with `git stash pop`."
            >
              <button type="button" className={BTN_GHOST_CLASS} disabled={act.isPending} onClick={() => act.mutate({ action: "stash" })}>
                Stash all
              </button>
            </Tooltip>
            <Tooltip
              multiline
              content="Permanently discards every uncommitted change in this repo — this cannot be undone. Use Stash all instead if you might want them back."
            >
              <button type="button" className={BTN_GHOST_CLASS} disabled={act.isPending} onClick={discardAll}>
                Discard all
              </button>
            </Tooltip>
          </span>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-gray-400">loading changes…</p>
      ) : (
        <DiffBrowser
          files={files}
          fetchFileDiff={(f) => fetchAppFileDiff(app.name, f.path, f.untracked, base).then((r) => r.diff)}
          fileDiffKey={(f) => ["app-file-diff", app.name, base, f.path, f.untracked]}
          fetchFullDiff={() => fetchAppFullDiff(app.name, base).then((r) => r.diff)}
          fullDiffKey={["app-full-diff", app.name, base]}
          emptyText={base === "head" ? "Working tree is clean." : `No differences vs ${def}.`}
          selectedPaths={base === "head" ? selected : undefined}
          onToggleSelect={base === "head" ? toggleSelect : undefined}
          selectionToolbar={selectionToolbar}
          fileAction={(f) =>
            base === "head" ? (
              <>
                <OpenPathButton path={`${app.absolutePath}/${f.path}`} title="Open file in editor" />
                <Tooltip content="Discard this file's changes">
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ action: "discard", paths: [f.path] })}
                  >
                    Drop
                  </button>
                </Tooltip>
              </>
            ) : (
              <OpenPathButton path={`${app.absolutePath}/${f.path}`} title="Open file in editor" />
            )
          }
        />
      )}
    </section>
  );
}

/**
 * Stash manager: list the app's stashes, expand one to browse its diff (its own
 * captured changes, or vs the current working tree), and apply / pop / drop / clear.
 * Apply & pop surface conflicts with an Open-in-editor + Undo (revert to the
 * pre-apply state) affordance, so a messy apply is always recoverable.
 */
function StashSection({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ files: string[]; undoToken: string | null } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["app-stashes", app.name], queryFn: () => fetchAppStashes(app.name) });
  const stashes = data?.stashes ?? [];

  const invalidate = () => {
    for (const k of [
      ["app-stashes", app.name],
      ["app-stash-files", app.name],
      ["app-stash-file-diff", app.name],
      ["app-stash-full-diff", app.name],
      ["app-diff", app.name],
      ["app-full-diff", app.name],
      ["app-file-diff", app.name],
      ["app-details", app.name],
      ["apps"],
    ]) {
      qc.invalidateQueries({ queryKey: k });
    }
  };

  const act = useMutation({
    mutationFn: (body: { action: StashAction; ref?: string; undoToken?: string | null }) => runAppStash(app.name, body),
    onSuccess: (res) => {
      invalidate();
      if (res.conflicted) {
        setConflict({ files: res.conflictedFiles ?? [], undoToken: res.undoToken ?? null });
        notify(`${res.action}: ${res.conflictedFiles?.length ?? 0} conflicting file(s) — resolve in editor or undo`, "warning");
      } else if (res.ok) {
        setConflict(null);
        notify(res.action === "undo" ? "Reverted to the pre-apply state" : `Stash ${res.action} ok`, "success");
      } else {
        notify(`Stash ${res.action} failed: ${res.error ?? "error"}`, "error");
      }
    },
    onError: (e) => notify(e instanceof Error ? e.message : "stash action failed", "error"),
  });

  const openEditor = useMutation({
    mutationFn: () => openApp(app.name),
    onError: (e) => notify(e instanceof Error ? e.message : "open failed", "error"),
  });

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading>Stashes</SectionHeading>
        <span className="text-xs text-gray-400">{stashes.length}</span>
        {stashes.length > 0 && (
          <button
            type="button"
            className={`${BTN_GHOST_CLASS} ml-auto`}
            disabled={act.isPending}
            onClick={async () => {
              const ok = await confirm({
                prompt: `Clear ALL ${stashes.length} stash(es) for ${app.name}?`,
                flavorText: "This cannot be undone.",
                confirmText: "Clear all",
              });
              if (ok) act.mutate({ action: "clear" });
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {conflict && (
        <Alert tone="warning" className="mb-2">
          <p>
            The last apply/pop left conflicts in {conflict.files.length} file(s):{" "}
            <span className="font-mono">{conflict.files.join(", ")}</span>. Resolve them in your editor, or undo to revert
            to the state before applying (the stash is kept either way).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={BTN_GHOST_CLASS} disabled={openEditor.isPending} onClick={() => openEditor.mutate()}>
              Open in editor
            </button>
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={act.isPending}
              onClick={() => act.mutate({ action: "undo", undoToken: conflict.undoToken })}
            >
              Undo (revert to pre-apply)
            </button>
            <button type="button" className="text-xs text-gray-400 hover:underline" onClick={() => setConflict(null)}>
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {isLoading ? (
        <p className="text-xs text-gray-400">loading stashes…</p>
      ) : stashes.length === 0 ? (
        <p className="text-xs text-gray-400">No stashes for this app.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {stashes.map((s) => (
            <StashRow
              key={s.ref}
              app={app}
              stash={s}
              open={openRef === s.ref}
              onToggle={() => setOpenRef(openRef === s.ref ? null : s.ref)}
              busy={act.isPending}
              onApply={() => act.mutate({ action: "apply", ref: s.ref })}
              onPop={async () => {
                const ok = await confirm({
                  prompt: `Pop ${s.ref}?`,
                  flavorText: "Applies the stash, then drops it on success. On conflict it is kept.",
                  confirmText: "Pop",
                });
                if (ok) act.mutate({ action: "pop", ref: s.ref });
              }}
              onDrop={async () => {
                const ok = await confirm({
                  prompt: `Drop ${s.ref}?`,
                  flavorText: "This cannot be undone.",
                  confirmText: "Drop",
                });
                if (ok) act.mutate({ action: "drop", ref: s.ref });
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One stash row: header + actions, and (when expanded) a mode-toggled DiffBrowser. */
function StashRow({
  app,
  stash,
  open,
  onToggle,
  busy,
  onApply,
  onPop,
  onDrop,
}: {
  app: AppConfig;
  stash: StashEntry;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
}) {
  const [mode, setMode] = useState<StashDiffMode>("stash");
  const filesQ = useQuery({
    queryKey: ["app-stash-files", app.name, stash.ref, mode],
    queryFn: () => fetchAppStashFiles(app.name, stash.ref, mode),
    enabled: open,
  });
  const files = filesQ.data?.files ?? [];

  const modeToggle = (
    <div className="inline-flex overflow-hidden rounded-lg border border-gray-300 text-xs dark:border-gray-700">
      {(
        [
          ["stash", "Stash's changes"],
          ["worktree", "vs current files"],
        ] as const
      ).map(([m, lbl]) => (
        <button
          key={m}
          type="button"
          className={mode === m ? "bg-accent px-2.5 py-1 text-white" : "px-2.5 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"}
          onClick={() => setMode(m)}
        >
          {lbl}
        </button>
      ))}
    </div>
  );

  return (
    <li className="rounded-lg border border-gray-200 p-2 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <DisclosureButton
          open={open}
          onToggle={onToggle}
          className="min-w-0 flex-1"
          classNames={{ arrow: "text-gray-400" }}
        >
          <Badge tone="accent">{stash.ref}</Badge>
          <span className="truncate text-sm">{stash.message}</span>
          {stash.relativeDate && <span className="ml-1 shrink-0 text-xs text-gray-400">{stash.relativeDate}</span>}
        </DisclosureButton>
        <span className="flex shrink-0 gap-1">
          <button type="button" className={BTN_GHOST_CLASS} disabled={busy} onClick={onApply}>
            Apply
          </button>
          <button type="button" className={BTN_GHOST_CLASS} disabled={busy} onClick={onPop}>
            Pop
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
            disabled={busy}
            onClick={onDrop}
          >
            Drop
          </button>
        </span>
      </div>
      {open && (
        <div className="mt-2">
          {filesQ.isLoading ? (
            <p className="text-xs text-gray-400">loading…</p>
          ) : (
            <DiffBrowser
              files={files}
              toolbar={modeToggle}
              fetchFileDiff={(f) => fetchAppStashFileDiff(app.name, stash.ref, f.path, mode).then((r) => r.diff)}
              fileDiffKey={(f) => ["app-stash-file-diff", app.name, stash.ref, mode, f.path]}
              fetchFullDiff={() => fetchAppStashFullDiff(app.name, stash.ref, mode).then((r) => r.diff)}
              fullDiffKey={["app-stash-full-diff", app.name, stash.ref, mode]}
              fileAction={(f) => <OpenPathButton path={`${app.absolutePath}/${f.path}`} title="Open file in editor" />}
              emptyText="No file changes in this stash."
            />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Tag manager: list tags with metadata (target commit + subject, date, annotated
 * vs lightweight + message), create a tag (annotated when a message is given) on
 * HEAD or a given ref, check a tag out (detached HEAD), or delete it.
 */
function TagsSection({ app }: { app: AppConfig }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [refInput, setRefInput] = useState("");

  const { data, isLoading } = useQuery({ queryKey: ["app-tags", app.name], queryFn: () => fetchAppTags(app.name) });
  const tags = data?.tags ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["app-tags", app.name] });
    qc.invalidateQueries({ queryKey: ["app-details", app.name] });
  };

  const create = useMutation({
    mutationFn: () =>
      createAppTag(app.name, { name: name.trim(), message: message.trim() || undefined, ref: refInput.trim() || undefined }),
    onSuccess: (r) => {
      if (r.ok) {
        setName("");
        setMessage("");
        setRefInput("");
        invalidate();
        notify("Tag created", "success");
      } else {
        notify(r.error ?? "tag failed", "error");
      }
    },
    onError: (e) => notify(e instanceof Error ? e.message : "tag failed", "error"),
  });

  const act = useMutation({
    mutationFn: ({ action, tag }: { action: TagAction; tag: string }) => runAppTag(app.name, action, tag),
    onSuccess: (r, vars) => {
      invalidate();
      if (vars.action === "checkout") qc.invalidateQueries({ queryKey: ["apps"] });
      notify(
        r.ok ? `${vars.action} ${r.branch ? `→ ${r.branch}` : "ok"}` : `${vars.action} failed: ${r.error ?? "error"}`,
        r.ok ? "success" : "error",
      );
    },
    onError: (e) => notify(e instanceof Error ? e.message : "tag action failed", "error"),
  });

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading>Tags</SectionHeading>
        <span className="text-xs text-gray-400">{tags.length}</span>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          className={`${FIELD_CLASS} max-w-[160px]`}
          placeholder="new tag name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={`${FIELD_CLASS} max-w-[220px]`}
          placeholder="message (optional → annotated)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <input
          className={`${FIELD_CLASS} max-w-[150px]`}
          placeholder="commit/ref (def HEAD)"
          value={refInput}
          onChange={(e) => setRefInput(e.target.value)}
        />
        <button type="button" className={BTN_PRIMARY_CLASS} disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Tagging…" : "Add tag"}
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-gray-400">loading tags…</p>
      ) : tags.length === 0 ? (
        <p className="text-xs text-gray-400">No tags.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {tags.map((t) => (
            <li key={t.name} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-sm">
              <span className="font-medium">{t.name}</span>
              {t.annotated && <Badge tone="accent">annotated</Badge>}
              <span className="font-mono text-xs text-gray-400">{t.commit}</span>
              {t.subject && <span className="min-w-0 truncate text-xs text-gray-500">{t.subject}</span>}
              {t.date && <span className="shrink-0 text-xs text-gray-400">{new Date(t.date).toLocaleDateString()}</span>}
              <span className="ml-auto flex shrink-0 gap-1">
                <button type="button" className={BTN_GHOST_CLASS} disabled={act.isPending} onClick={() => act.mutate({ action: "checkout", tag: t.name })}>
                  Checkout
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-xs text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                  disabled={act.isPending}
                  onClick={async () => {
                    const ok = await confirm({ prompt: `Delete tag ${t.name}?`, confirmText: "Delete" });
                    if (ok) act.mutate({ action: "delete", tag: t.name });
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
/** The app's README, rendered as markdown (GFM + syntax-highlighted code). */
function ReadmeSection({ readme }: { readme: NonNullable<AppDetails["readme"]> }) {
  return (
    <section>
      <SectionHeading>{readme.name}</SectionHeading>
      <article className="chat-md min-w-0 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {readme.content}
        </ReactMarkdown>
      </article>
    </section>
  );
}

/** A readable summary of the most useful fields, derived from the app config. */
function Overview({ app }: { app: AppConfig }) {
  const apis = app.apis ?? [];
  const dbs = app.db ?? [];
  return (
    <section className="space-y-2">
      <InfoRow label="Path">
        <span className="inline-flex items-center gap-1">
          <span className="break-all font-mono text-xs">{app.absolutePath}</span>
          <OpenPathButton path={app.absolutePath} />
        </span>
      </InfoRow>
      {app.group && (
        <InfoRow label="Group">
          <span className="inline-flex items-center gap-1">
            {app.group}
            <OpenPathButton
              path={groupDir(app.absolutePath)}
              title={`Open the ${app.group} group folder (${groupDir(app.absolutePath)}) in editor`}
            />
          </span>
        </InfoRow>
      )}
      {app.dirName && (
        <InfoRow label="Directory">
          <span className="font-mono text-xs">{app.dirName}</span>
        </InfoRow>
      )}
      {app.repoName && (
        <InfoRow label="Repo">
          <span className="font-mono text-xs">{app.repoName}</span>
        </InfoRow>
      )}
      {app.packageJsonName && (
        <InfoRow label="Package">
          <span className="font-mono text-xs">{app.packageJsonName}</span>
        </InfoRow>
      )}
      {(app.aliases ?? []).length > 0 && (
        <InfoRow label="Aliases">
          <span className="flex flex-wrap gap-1">
            {app.aliases.map((x) => (
              <Badge key={x} tone="neutral">
                {x}
              </Badge>
            ))}
          </span>
        </InfoRow>
      )}
      {apis.length > 0 && (
        <InfoRow label="APIs">
          <span className="flex flex-wrap gap-1">
            {apis.map((api) => (
              <Badge key={api.name} tone="accent">
                {api.name}
              </Badge>
            ))}
          </span>
        </InfoRow>
      )}
      {dbs.length > 0 && (
        <InfoRow label="Databases">
          <span className="flex flex-wrap gap-1">
            {dbs.map((d) => (
              <Badge key={d} tone="neutral">
                {d}
              </Badge>
            ))}
          </span>
        </InfoRow>
      )}
      {(app.managed || app.pinned || app.missing) && (
        <InfoRow label="Flags">
          <span className="flex flex-wrap gap-1">
            {app.managed && <Badge tone="neutral">managed</Badge>}
            {app.pinned && <Badge tone="accent">pinned</Badge>}
            {app.missing && <Badge tone="error">missing</Badge>}
          </span>
        </InfoRow>
      )}
    </section>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-24 shrink-0 text-xs font-medium text-gray-500">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** The full app config rendered as a syntax-highlighted JSON code block. */
function JsonBlock({ json }: { json: string }) {
  return (
    <div className="overflow-auto rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      <ReactMarkdown
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: (props: ComponentPropsWithoutRef<"pre">) => <pre className="m-0 font-mono text-xs" {...props} />,
        }}
      >
        {`\`\`\`json\n${json}\n\`\`\``}
      </ReactMarkdown>
    </div>
  );
}
