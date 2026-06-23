// The app sidebar: a color-coded, customizable nav of top-level pages + the
// category hubs, driven by the shared SIDEBAR registry (→ a cwip NavigationModel,
// see navigationModel.ts) and the user's localStorage prefs (show/hide, color,
// order, collapsed). The drag-reorder, per-row kebab (recolor/hide), and
// restore-hidden menu are the shared cwip/react `SideNav`; this file owns the aside
// shell (header, live dot, footer) + rubato's data, routing, and theming. Searching
// pages now lives in the top-nav HeaderSearch (App.tsx), so the sidebar no longer
// carries its own search box. The mobile drawer + hamburger live in App.tsx.

import type { UiPage } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { SideNav as CwipSideNav, type NavPreferences } from "cursedbelt/react";
import { useCallback, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { fetchUi } from "../api";
import { appBrand } from "../brand";
import { Tooltip } from "../components";
import { IconSliders, IconX } from "../icons";
import { buildRubatoNavModel, resolveNavIcon, toNavPreferences } from "../navigationModel";
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
  const { prefs, setCollapsed, patch } = useNavPrefs();
  const collapsed = prefs.collapsed;

  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });
  const enabled = useMemo(
    () => (pages ? Object.fromEntries(pages.map((p) => [p.key, true])) : (ui?.pages ?? {})),
    [pages, ui?.pages],
  );
  const adminOn = !pages && ui?.admin === true;

  // The whole rail derives from the shared registry → a cwip NavigationModel; the
  // SideNav handles ordering/hiding/active highlight from `prefs` + `activeHref`. A
  // hub with exactly one enabled page collapses to a direct page row (see the model
  // builder), and Admin joins as a normal customizable row when owner-enabled.
  const model = useMemo(() => buildRubatoNavModel(enabled, adminOn), [enabled, adminOn]);
  const navPreferences = useMemo(() => toNavPreferences(prefs), [prefs]);
  const onPrefsChange = useCallback(
    (next: NavPreferences) =>
      patch({ order: next.order ?? [], hidden: next.hidden ?? [], colors: next.colors ?? {} }),
    [patch],
  );

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
        model={model}
        activeHref={location.pathname}
        prefs={navPreferences}
        onPrefsChange={onPrefsChange}
        collapsed={collapsed}
        linkComponent={Link}
        onNavigate={onClose}
        resolveIcon={resolveNavIcon}
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
