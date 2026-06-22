// The app sidebar: a color-coded, customizable nav of top-level pages + the
// category hubs, driven by the shared SIDEBAR registry and the user's localStorage
// prefs (show/hide, color, order, collapsed). The drag-reorder, per-row kebab
// (recolor/hide), and restore-hidden menu are the shared cwip/react `SideNav`; this
// file owns the aside shell (header, live dot, footer) + rubato's data, routing, and
// theming. Searching pages now lives in the top-nav HeaderSearch (App.tsx), so the
// sidebar no longer carries its own search box. The mobile drawer + hamburger live
// in App.tsx.

import { type NavGroup, pagesInGroup, SIDEBAR, type UiPage } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { type NavEntry, type NavPrefsActions, SideNav as CwipSideNav } from "cursedbelt/react";
import { Link, useLocation } from "react-router-dom";
import { fetchUi } from "../api";
import { appBrand } from "../brand";
import { Tooltip } from "../components";
import { IconFileText, IconSliders, IconX } from "../icons";
import { PAGE_ICONS, resolveSidebarEntry } from "../navMeta";
import { useNavPrefs } from "../navPrefs";
import { ThemeToggle } from "../ThemeToggle";
import { useLive } from "../useLive";

const DOT: Record<string, string> = {
  open: "bg-emerald-500",
  connecting: "bg-amber-500",
  closed: "bg-gray-400",
};

/** True when `pathname` is `path` or a sub-route of it (`/apps` matches `/apps/x`). */
function matchPath(pathname: string, path: string): boolean {
  if (pathname === path) return true;
  return path !== "/" && pathname.startsWith(`${path}/`);
}

// rubato's active highlight uses the accent token (over cwip's neutral-gray default).
const ITEM_CLASSNAMES = { active: () => "bg-accent-soft text-accent" } as const;

export function SideNav({
  navOpen,
  onClose,
  pages,
  brand = appBrand(),
}: {
  navOpen: boolean;
  onClose: () => void;
  /** Friend-app override: when given, these page keys are the enabled set (and
   *  admin is hidden) instead of the server-reported `/api/ui` enablement. */
  pages?: UiPage[];
  /** Brand wordmark (default: the runtime brand — see `appBrand`). */
  brand?: string;
}) {
  const live = useLive();
  const location = useLocation();
  const { prefs, setCollapsed, setOrder, setHidden, setColor } = useNavPrefs();
  const collapsed = prefs.collapsed;

  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });
  const enabled = pages ? Object.fromEntries(pages.map((p) => [p.key, true])) : (ui?.pages ?? {});
  const adminOn = !pages && ui?.admin === true;

  // A hub is active on its own landing page or on any of its member pages.
  const isActive = (id: string, kind: "page" | "hub", path: string): boolean => {
    if (matchPath(location.pathname, path)) return true;
    if (kind === "hub") {
      return pagesInGroup(id as Exclude<NavGroup, "top">).some((p) => matchPath(location.pathname, p.path));
    }
    return false;
  };

  // Resolve SIDEBAR → eligible entries (drop entries whose page/hub has nothing
  // enabled); hide/color/active are resolved here, the cwip SideNav orders + hides.
  // A hub with exactly one enabled page is collapsed to a direct page link so it
  // doesn't force an unnecessary hub landing page (e.g. a QA app with only Browser).
  const entries: NavEntry[] = [];
  for (const sidebarEntry of SIDEBAR) {
    const r = resolveSidebarEntry(sidebarEntry);
    if (!r) continue;
    if (r.kind === "page" && !enabled[r.id]) continue;
    if (r.kind === "hub") {
      const hubPages = pagesInGroup(r.id as Exclude<NavGroup, "top">).filter((p) => enabled[p.key]);
      if (hubPages.length === 0) continue;
      if (hubPages.length === 1) {
        // Only one page in this hub — bypass the hub and link directly to the page.
        const p = hubPages[0];
        entries.push({
          id: p.key,
          label: p.label,
          href: p.path,
          icon: PAGE_ICONS[p.key],
          active: isActive(p.key, "page", p.path),
          color: prefs.colors[p.key] ?? p.color,
          hidden: prefs.hidden.includes(p.key),
        });
        continue;
      }
    }
    entries.push({
      id: r.id,
      label: r.label,
      href: r.path,
      icon: r.icon,
      active: isActive(r.id, r.kind, r.path),
      color: prefs.colors[r.id] ?? r.defaultColor,
      hidden: prefs.hidden.includes(r.id),
    });
  }
  // Admin is owner-gated (config `ui.admin`); it joins the list as a normal,
  // customizable entry when enabled.
  if (adminOn) {
    entries.push({
      id: "/admin",
      label: "Admin",
      href: "/admin",
      icon: <IconFileText />,
      active: matchPath(location.pathname, "/admin"),
      color: prefs.colors["/admin"],
      hidden: prefs.hidden.includes("/admin"),
    });
  }

  const actions: NavPrefsActions = {
    setOrder,
    setHidden: (entry, hidden) => setHidden(entry.id, hidden),
    setColor: (entry, color) => setColor(entry.id, color),
  };

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-64 max-w-[80vw] shrink-0 flex-col border-r border-gray-200 bg-white p-4 transition-[transform,width] duration-200 ease-out md:static md:z-auto md:max-w-none md:translate-x-0 md:shadow-none dark:border-gray-800 dark:bg-gray-900 ${
        collapsed ? "md:w-16 md:px-2" : "md:w-48"
      } ${navOpen ? "translate-x-0 shadow-xl" : "-translate-x-full"}`}
    >
      <div className="mb-1 flex items-center justify-between">
        <h1 className={`text-lg font-bold tracking-tight ${collapsed ? "md:hidden" : ""}`}>
          <span className="text-accent">{brand}</span>
        </h1>
        <button type="button" aria-label="Close navigation" className="icon-btn md:hidden" onClick={onClose}>
          <IconX size={24} />
        </button>
      </div>
      <Tooltip content={`live: ${live}`}>
      <div
        className={`mb-4 flex items-center gap-1.5 text-xs text-gray-400 ${collapsed ? "md:justify-center" : ""}`}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${DOT[live]}`} />
        <span className={collapsed ? "md:hidden" : ""}>{live}</span>
      </div>
      </Tooltip>

      <CwipSideNav
        entries={entries}
        order={prefs.order}
        actions={actions}
        collapsed={collapsed}
        linkComponent={Link}
        onNavigate={onClose}
        itemClassNames={ITEM_CLASSNAMES}
      />

      {/* Footer: collapse button stays anchored at the bottom-left corner.
          In the expanded row it's first (leftmost); when the sidebar collapses to
          a column, order-last pushes it to the bottom so it never "jumps up". */}
      <div
        className={`mt-3 flex items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800 ${
          collapsed ? "md:flex-col md:items-center" : ""
        }`}
      >
        <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`icon-btn hidden md:inline-flex ${collapsed ? "md:order-last" : ""}`}
        >
          <span aria-hidden className="text-2xl leading-none">
            {collapsed ? "»" : "«"}
          </span>
        </button>
        </Tooltip>
        <ThemeToggle />
        <Tooltip content="Settings">
        <Link
          to="/settings"
          aria-label="Settings"
          className={`icon-btn ${matchPath(location.pathname, "/settings") ? "text-accent" : ""}`}
          onClick={onClose}
        >
          <IconSliders size={24} />
        </Link>
        </Tooltip>
      </div>
    </aside>
  );
}
