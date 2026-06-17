// AppShell — rubato's nav + layout chrome, extracted from App.tsx so external
// ("friend") apps can reuse it. It owns the sidebar (SideNav), the top bar
// (HeaderSearch + mobile hamburger/brand/live-dot), the breadcrumb trail, and the
// main scroll region; the routed page content is supplied as `children` (a
// `<Routes>` element). rubato's own App.tsx renders `<AppShell>` with no props, so
// its behaviour is unchanged; a friend app passes `accent`/`label`/`pages` to rebrand and
// scope the nav. See the plugin-system plan (Stage 4).

import type { UiPage } from "@shared/ui";
import { ScrollToTopButton } from "cwip/react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { appBrand } from "../brand";
import { AppBreadcrumbs } from "../breadcrumbs";
import { Tooltip } from "../components";
import { HeaderSearch } from "../components/HeaderSearch";
import { SideNav } from "../components/SideNav";
import { IconMenu } from "../icons";
import { useLive } from "../useLive";

const DOT: Record<string, string> = {
  open: "bg-emerald-500",
  connecting: "bg-amber-500",
  closed: "bg-gray-400",
};

export interface AppShellProps {
  /** Brand accent as a CSS color (e.g. `#7c3aed`); sets `--color-accent` on the
   *  shell wrapper so every accent utility re-themes. Omit to inherit rubato's own
   *  violet token from `styles.css`. */
  accent?: string;
  /** Brand label displayed in the mobile header. Defaults to "rubato". */
  label?: string;
  /** Nav items to show. Omit to use the server-reported page set (rubato default). */
  pages?: UiPage[];
  /** Routed content — the app's `<Routes>`. */
  children: ReactNode;
}

export function AppShell({ accent, label = appBrand(), pages, children }: AppShellProps) {
  const live = useLive();

  // Mobile nav drawer: hidden off-canvas below `md`, always-on static at `md+`.
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);
  const location = useLocation();
  // Close the drawer whenever the route changes (covers link taps + programmatic
  // navigation), and on Escape.
  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Inline override of the accent token (cascades to every `text-accent`,
  // `bg-accent`, … utility) when a friend app brands the shell.
  const wrapperStyle = accent ? ({ "--color-accent": accent } as CSSProperties) : undefined;

  return (
    <div
      style={wrapperStyle}
      className="flex h-dvh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100"
    >
      {/* Dimmed backdrop behind the open drawer (mobile only). */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={closeNav}
        />
      )}
      <SideNav navOpen={navOpen} onClose={closeNav} pages={pages} brand={label} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: the global content-search box (always shown) plus the mobile-only
            hamburger + brand + live dot (the sidebar carries those on desktop). */}
        <header className="relative z-50 flex shrink-0 items-center gap-2 border-b border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
          <button
            type="button"
            aria-label="Open navigation"
            className="icon-btn md:hidden"
            onClick={() => setNavOpen(true)}
          >
            <IconMenu size={24} />
          </button>
          <span className="text-lg font-bold tracking-tight text-accent md:hidden">{label}</span>
          <Tooltip content={`live: ${live}`}>
            <span className={`ml-1 inline-block h-2 w-2 shrink-0 rounded-full md:hidden ${DOT[live]}`} />
          </Tooltip>
          <HeaderSearch />
        </header>
        <main className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
          <ScrollToTopButton />
          <div className="mx-auto h-full w-full max-w-4xl">
            <AppBreadcrumbs />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
