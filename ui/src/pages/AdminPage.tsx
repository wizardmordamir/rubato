import { useState } from "react";
import { PageHeading, Tabs } from "../components";
import { BackupsPanel } from "./admin/BackupsPanel";
import { BackupViewerPanel } from "./admin/BackupViewerPanel";
import { DbViewerPanel } from "./admin/DbViewerPanel";
import { DiagnosticsPanel } from "./admin/DiagnosticsPanel";
import { SystemHealthPanel } from "./admin/SystemHealthPanel";

// Page enablement now lives in Settings → Pages (discoverable, ungated). Admin keeps
// the operational panels: health, diagnostics, backups, and the DB viewers.
const TABS = [
  { key: "system-health", label: "System Health", render: () => <SystemHealthPanel /> },
  { key: "diagnostics", label: "Diagnostics", render: () => <DiagnosticsPanel /> },
  { key: "backups", label: "Backups", render: () => <BackupsPanel /> },
  { key: "backup-viewer", label: "Backup Viewer", render: () => <BackupViewerPanel /> },
  { key: "db", label: "DB Viewer", render: () => <DbViewerPanel /> },
] as const;

/** Admin: DB backups + viewers + health/diagnostics. Gated by `ui.admin` in config. */
export function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("system-health");
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <div>
      <PageHeading title="Admin" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {active.render()}
    </div>
  );
}
