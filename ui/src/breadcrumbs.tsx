import { type NavGroup, NAV_HUBS, UI_PAGES } from "@shared/ui";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";

// The app's breadcrumb trail — "where am I in the hubs, and how do I climb back
// out to any level". The hierarchy is derived from the single source of truth for
// nav (UI_PAGES + NAV_HUBS): every hub-child page hangs off its hub, and the
// drill-down detail routes hang off their list page. A small local trail walker +
// renderer (rather than cwip's model-derived <Breadcrumbs>) so the dynamic detail
// routes — which aren't NavigationModel items — keep their full trail and the
// per-page leaf-label registration below. Rendered once globally (see App.tsx) so
// no page wires its own back button.

/** A node in the flat breadcrumb hierarchy: its key (the path), label, parent key. */
interface BreadcrumbNode {
  key: string;
  label: string;
  parent?: string;
}

/** One resolved crumb. `href` is omitted for the current (leaf) page. */
interface Crumb {
  key: string;
  label: string;
  href?: string;
}

/** Walk `nodes` from `startKey` to the root (root-first), applying the leaf overrides. */
function buildTrail(
  nodes: Record<string, BreadcrumbNode>,
  startKey: string,
  opts: { leafLabel?: string; leafHref?: string } = {},
): Crumb[] {
  const chain: Crumb[] = [];
  let cur: string | undefined = startKey;
  while (cur) {
    const node: BreadcrumbNode | undefined = nodes[cur];
    if (!node) break;
    chain.unshift({ key: node.key, label: node.label, href: node.key });
    cur = node.parent;
  }
  const last = chain[chain.length - 1];
  if (last) {
    if (opts.leafLabel) last.label = opts.leafLabel;
    if (opts.leafHref) last.href = opts.leafHref;
  }
  return chain;
}

/** Render a crumb trail; collapses the middle to an ellipsis past `maxItems`. */
function BreadcrumbTrail({ items, maxItems = 5 }: { items: Crumb[]; maxItems?: number }) {
  const shown: Array<Crumb | "ellipsis"> =
    items.length > maxItems ? [items[0], "ellipsis", ...items.slice(items.length - (maxItems - 2))] : items;
  return (
    <ol className="flex items-center gap-1.5 overflow-x-auto text-sm text-gray-500 dark:text-gray-400">
      {shown.map((c, i) => {
        const isLast = i === shown.length - 1;
        return (
          <li key={c === "ellipsis" ? "ellipsis" : c.key} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-gray-300 dark:text-gray-600">
                ›
              </span>
            )}
            {c === "ellipsis" ? (
              <span className="text-gray-400">…</span>
            ) : isLast || !c.href ? (
              <span aria-current="page" className="font-medium text-gray-700 dark:text-gray-200">
                {c.label}
              </span>
            ) : (
              <Link to={c.href} className="hover:text-accent">
                {c.label}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Path of the hub that owns a non-top page group. */
const hubPath = (group: Exclude<NavGroup, "top">): string | undefined =>
  NAV_HUBS.find((h) => h.key === group)?.path;

/**
 * The route hierarchy, keyed by route path/pattern. Top-level pages + hubs are
 * roots; hub-child pages parent onto their hub; the dynamic drill-down routes
 * (kept in sync with App.tsx) parent onto their list page.
 */
function buildNodes(): Record<string, BreadcrumbNode> {
  const nodes: Record<string, BreadcrumbNode> = {};
  for (const p of UI_PAGES) {
    if (p.mergedInto) continue;
    nodes[p.path] = {
      key: p.path,
      label: p.label,
      parent: p.group === "top" ? undefined : hubPath(p.group),
    };
  }
  for (const h of NAV_HUBS) nodes[h.path] = { key: h.path, label: h.label };
  // Drill-down routes — pattern keys. Leaf labels come from the URL param (or a
  // page-registered record name); the static label here is the fallback.
  const detail: BreadcrumbNode[] = [
    { key: "/apps/templates", label: "Templates", parent: "/" },
    { key: "/apps/:name", label: "App", parent: "/" },
    { key: "/commands/:name", label: "Command", parent: "/commands" },
    { key: "/automations/new", label: "New", parent: "/automations" },
    { key: "/automations/:id", label: "Automation", parent: "/automations" },
    { key: "/automations/:id/edit", label: "Edit", parent: "/automations" },
    { key: "/excel-automations/:id", label: "Excel Automation", parent: "/excel" },
    { key: "/art-tuning", label: "Fooocus Tuning", parent: "/chat" },
  ];
  for (const n of detail) nodes[n.key] = n;
  return nodes;
}

const NODES = buildNodes();

/** Dynamic routes → their hierarchy key + captured param, most-specific first. */
const DYNAMIC: Array<{ re: RegExp; key: string }> = [
  { re: /^\/automations\/([^/]+)\/edit$/, key: "/automations/:id/edit" },
  { re: /^\/automations\/([^/]+)$/, key: "/automations/:id" },
  { re: /^\/apps\/([^/]+)$/, key: "/apps/:name" },
  { re: /^\/commands\/([^/]+)$/, key: "/commands/:name" },
  { re: /^\/excel-automations\/([^/]+)$/, key: "/excel-automations/:id" },
];

type Match = { key: string; param?: string };

/** Resolve a concrete pathname to a hierarchy node key (+ captured detail param). */
function resolveRoute(pathname: string): Match | null {
  if (NODES[pathname]) return { key: pathname };
  for (const d of DYNAMIC) {
    const m = d.re.exec(pathname);
    if (m) return { key: d.key, param: m[1] ? decodeURIComponent(m[1]) : undefined };
  }
  return null;
}

// ── Leaf-label registration ──────────────────────────────────────────────────
// A detail page publishes its record's display name so the current (leaf) crumb
// reads "Browser › My Flow" rather than "Browser › 42". Mirrors cursedalchemy's
// page-meta hook. Absent → the leaf falls back to the URL param, then the node's
// static label.

// Split into a value context (the label, re-renders the bar) and a setter context.
// The setter is a stable useState dispatcher, so the register effect below depends
// only on it + the label arg — never on the changing value — and so can't loop.
const LabelValueCtx = createContext<string | null>(null);
const SetLabelCtx = createContext<(l: string | null) => void>(() => {});

export function BreadcrumbLabelProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  return (
    <SetLabelCtx.Provider value={setLabel}>
      <LabelValueCtx.Provider value={label}>{children}</LabelValueCtx.Provider>
    </SetLabelCtx.Provider>
  );
}

/** Publish the current page's leaf-crumb label while mounted (clears on unmount). */
export function useRegisterBreadcrumbLabel(label: string | null | undefined): void {
  const setLabel = useContext(SetLabelCtx);
  useEffect(() => {
    setLabel(label ?? null);
    return () => setLabel(null);
  }, [setLabel, label]);
}

/**
 * The global breadcrumb bar. Renders nothing on top-level pages and hub landings
 * (a single-crumb trail needs no "up" affordance) — only once you've drilled into
 * a hub child or a detail record.
 */
export function AppBreadcrumbs() {
  const { pathname } = useLocation();
  const registered = useContext(LabelValueCtx);

  const items = useMemo(() => {
    const match = resolveRoute(pathname);
    if (!match) return [];
    return buildTrail(NODES, match.key, {
      leafLabel: registered ?? match.param ?? undefined,
      leafHref: pathname,
    });
  }, [pathname, registered]);

  if (items.length <= 1) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-4 min-w-0">
      <BreadcrumbTrail items={items} maxItems={5} />
    </nav>
  );
}
