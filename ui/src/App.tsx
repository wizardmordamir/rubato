import { NAV_HUBS, UI_PAGES } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { fetchUi } from "./api";
import { AppBreadcrumbs } from "./breadcrumbs";
import { Tooltip } from "./components";
import { HeaderSearch } from "./components/HeaderSearch";
import { SideNav } from "./components/SideNav";
import { IconMenu } from "./icons";
import { AdminPage } from "./pages/AdminPage";
import { AppDetailPage, AppsPage } from "./pages/AppsPage";
import { AppTemplatesPage } from "./pages/AppTemplatesPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { BoardPage } from "./pages/BoardPage";
import { BuilderPage } from "./pages/BuilderPage";
import { ChatPage } from "./pages/ChatPage";
import { CommandDetailPage, CommandsPage } from "./pages/CommandsPage";
import { ConfigPage } from "./pages/ConfigPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DocsPage } from "./pages/DocsPage";
import { AutomationBuilderPage } from "./pages/ExcelAutomations/AutomationBuilderPage";
import { ExcelAutomationsPage } from "./pages/ExcelAutomations/ExcelAutomationsPage";
import { HubPage } from "./pages/HubPage";
import { LinksPage } from "./pages/LinksPage";
import { RequestsMergedPage } from "./pages/merged/RequestsMergedPage";
import { RunsMergedPage } from "./pages/merged/RunsMergedPage";
import { OrchestrationPage } from "./pages/OrchestrationPage";
import { OrchestrationProcessingPage } from "./pages/OrchestrationProcessingPage";
import { PagesPage } from "./pages/Pages/PagesPage";
import { PipelinesPage } from "./pages/PipelinesPage";
import { PlansPage } from "./pages/PlansPage";
import { QueriesPage } from "./pages/QueriesPage";
import { ReportsPage } from "./pages/ReportsPage";
import { TestReportsPage } from "./pages/TestReportsPage";
import { ScriptsPage } from "./pages/ScriptsPage";
import { ServiceNowPage } from "./pages/ServiceNowPage";
import { SessionPage } from "./pages/SessionPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SplunkPage } from "./pages/SplunkPage";
import { EnvComparePage } from "./pages/EnvComparePage";
import { SystemFilesPage } from "./pages/SystemFilesPage";
import { ToolsPage } from "./pages/ToolsPage";
import { VaultPage } from "./pages/VaultPage";
import { ViewAutomationPage } from "./pages/ViewAutomationPage";
import { VulnerabilitiesPage } from "./pages/VulnerabilitiesPage";
import { useLive } from "./useLive";

// Each toggle-able page → the element rendered at its route, keyed by UI_PAGES key.
// The three merged keys (excel/requests/runs) render their tabbed wrapper; the
// pages folded into them (services/archives/excel-automations) have no entry here —
// their old routes redirect into the parent's tab below.
const PAGE_ELEMENTS: Record<string, ReactNode> = {
  apps: <AppsPage />,
  dashboard: <DashboardPage />,
  queries: <QueriesPage />,
  splunk: <SplunkPage />,
  servicenow: <ServiceNowPage />,
  session: <SessionPage />,
  requests: <RequestsMergedPage />,
  commands: <CommandsPage />,
  scripts: <ScriptsPage />,
  automations: <AutomationsPage />,
  pipelines: <PipelinesPage />,
  runs: <RunsMergedPage />,
  files: <ReportsPage />,
  "test-reports": <TestReportsPage />,
  vulnerabilities: <VulnerabilitiesPage />,
  plans: <PlansPage />,
  excel: <ExcelAutomationsPage />,
  ask: <ChatPage />,
  board: <BoardPage />,
  links: <LinksPage />,
  vault: <VaultPage />,
  orchestration: <OrchestrationPage />,
  "orchestration-processing": <OrchestrationProcessingPage />,
  customPages: <PagesPage />,
  tools: <ToolsPage />,
  docs: <DocsPage />,
  "system-files": <SystemFilesPage />,
  "env-compare": <EnvComparePage />,
  config: <ConfigPage />,
};

const DOT: Record<string, string> = {
  open: "bg-emerald-500",
  connecting: "bg-amber-500",
  closed: "bg-gray-400",
};

export function App() {
  const live = useLive();
  // Page enablement gates both the sidebar nav and the registered routes.
  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });
  const pages = ui?.pages ?? {};
  const adminOn = ui?.admin === true;

  // Routable pages: every enabled page that isn't merged into another.
  const enabledPages = UI_PAGES.filter((p) => !p.mergedInto && pages[p.key]);
  const appsOn = !!pages.apps;
  const commandsOn = !!pages.commands;
  const automationsOn = !!pages.automations;
  // `excel` is the unified Excel Automations page; resolvePages folds the old
  // `excel-automations` toggle into it, so this also gates the builder route.
  const excelOn = !!pages.excel;
  // Where "/" (when Apps is off) and unknown/disabled routes land.
  const home = enabledPages[0]?.path ?? "/settings";

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

  return (
    <div className="flex h-dvh bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {/* Dimmed backdrop behind the open drawer (mobile only). */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={closeNav}
        />
      )}
      <SideNav navOpen={navOpen} onClose={closeNav} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: the global content-search box (always shown) plus the mobile-only
            hamburger + brand + live dot (the sidebar carries those on desktop). */}
        <header className="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
          <button
            type="button"
            aria-label="Open navigation"
            className="icon-btn md:hidden"
            onClick={() => setNavOpen(true)}
          >
            <IconMenu size={24} />
          </button>
          <span className="text-lg font-bold tracking-tight text-accent md:hidden">rubato</span>
          <Tooltip content={`live: ${live}`}>
            <span className={`ml-1 inline-block h-2 w-2 shrink-0 rounded-full md:hidden ${DOT[live]}`} />
          </Tooltip>
          <HeaderSearch />
        </header>
        <main className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
          <div className="mx-auto h-full w-full max-w-4xl">
            <AppBreadcrumbs />
            <Routes>
              {enabledPages.map((p) => (
                <Route key={p.key} path={p.path} element={PAGE_ELEMENTS[p.key]} />
              ))}
              {/* Category hubs — always reachable; each shows its enabled pages. */}
              {NAV_HUBS.map((h) => (
                <Route key={h.key} path={h.path} element={<HubPage hubKey={h.key} />} />
              ))}
              <Route path="/settings" element={<SettingsPage />} />
              {/* Old routes of merged pages → the right tab of the merged parent. */}
              <Route path="/services" element={<Navigate to="/requests?tab=services" replace />} />
              <Route path="/archives" element={<Navigate to="/runs?tab=archived" replace />} />
              <Route path="/excel-automations" element={<Navigate to="/excel" replace />} />
              {/* Capture folded into the Browser builder (record + capture in one session). */}
              <Route path="/capture" element={<Navigate to="/automations" replace />} />
              {appsOn && <Route key="app-templates" path="/apps/templates" element={<AppTemplatesPage />} />}
              {appsOn && <Route key="app-detail" path="/apps/:name" element={<AppDetailPage />} />}
              {commandsOn && <Route key="command-detail" path="/commands/:name" element={<CommandDetailPage />} />}
              {automationsOn && [
                <Route key="auto-new" path="/automations/new" element={<BuilderPage />} />,
                <Route key="auto-view" path="/automations/:id" element={<ViewAutomationPage />} />,
                <Route key="auto-edit" path="/automations/:id/edit" element={<BuilderPage />} />,
              ]}
              {excelOn && <Route key="xa-detail" path="/excel-automations/:id" element={<AutomationBuilderPage />} />}
              {adminOn && <Route path="/admin" element={<AdminPage />} />}
              {/* Unknown or disabled page → the first enabled page (or Config) —
                  but NOT while the toggles are still loading, or a deep link to a
                  toggled-on page would bounce to home before `ui` resolves. */}
              {ui && <Route path="*" element={<Navigate to={home} replace />} />}
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}
