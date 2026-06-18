import { NAV_HUBS, UI_PAGES } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { fetchUi } from "./api";
import { AdminPage } from "./pages/AdminPage";
import { AppDetailPage, AppsPage } from "./pages/AppsPage";
import { AppTemplatesPage } from "./pages/AppTemplatesPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { AutomationEnvironmentsPage } from "./pages/AutomationEnvironmentsPage";
import { BoardPage } from "./pages/BoardPage";
import { BuilderPage } from "./pages/BuilderPage";
import { ChatPage } from "./pages/ChatPage";
import { CommandDetailPage, CommandsPage } from "./pages/CommandsPage";
import { ConfigPage } from "./pages/ConfigPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DocsPage } from "./pages/DocsPage";
import { ForgePage } from "./pages/ForgePage";
import { AutomationBuilderPage } from "./pages/ExcelAutomations/AutomationBuilderPage";
import { ExcelAutomationsPage } from "./pages/ExcelAutomations/ExcelAutomationsPage";
import { HubPage } from "./pages/HubPage";
import { LinksPage } from "./pages/LinksPage";
import { ShellAliasesPage } from "./pages/ShellAliasesPage";
import { RequestsMergedPage } from "./pages/merged/RequestsMergedPage";
import { RunsMergedPage } from "./pages/merged/RunsMergedPage";
import { TaskqPage } from "./pages/TaskqPage";
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
import { AppShell } from "./shell/AppShell";

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
  automations: <AutomationsPage showSharing />,
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
  "shell-aliases": <ShellAliasesPage />,
  vault: <VaultPage />,
  taskq: <TaskqPage />,
  forge: <ForgePage />,
  customPages: <PagesPage />,
  tools: <ToolsPage />,
  docs: <DocsPage />,
  "system-files": <SystemFilesPage />,
  "env-compare": <EnvComparePage />,
  config: <ConfigPage />,
};

export function App() {
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

  // rubato itself uses the shell with no props — its accent comes from styles.css
  // and its nav from the server-reported page set (SideNav's own /api/ui fetch).
  return (
    <AppShell>
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
        {/* Legacy markdown orchestrator replaced by the SQLite taskq board. */}
        <Route path="/orchestration" element={<Navigate to="/taskq" replace />} />
        {/* Orchestration Processing merged into the Orchestration (taskq) page as a tab. */}
        <Route path="/orchestration-processing" element={<Navigate to="/taskq?tab=processing" replace />} />
        {appsOn && <Route key="app-templates" path="/apps/templates" element={<AppTemplatesPage />} />}
        {appsOn && <Route key="app-detail" path="/apps/:name" element={<AppDetailPage />} />}
        {commandsOn && <Route key="command-detail" path="/commands/:name" element={<CommandDetailPage />} />}
        {automationsOn && [
          <Route key="auto-envs" path="/automations/environments" element={<AutomationEnvironmentsPage />} />,
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
    </AppShell>
  );
}
