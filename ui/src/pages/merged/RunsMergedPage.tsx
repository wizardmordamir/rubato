// Merged "Runs" page: recent run history (the old /runs) and the runs you've kept
// on purpose (the old /archives) as tabs. The active tab lives in the URL (`?tab=`)
// so /archives redirects straight into the Archived tab.

import { useSearchParams } from "react-router-dom";
import { Tabs } from "../../components";
import { ArchivesPage } from "../ArchivesPage";
import { RunsPage } from "../RunsPage";

const TABS = [
  { key: "recent", label: "Recent" },
  { key: "archived", label: "Archived" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function RunsMergedPage() {
  const [params, setParams] = useSearchParams();
  const active: TabKey = params.get("tab") === "archived" ? "archived" : "recent";
  const setTab = (key: TabKey) => setParams(key === "recent" ? {} : { tab: key }, { replace: true });

  return (
    <div>
      <Tabs tabs={TABS} active={active} onChange={setTab} />
      {active === "recent" ? <RunsPage /> : <ArchivesPage />}
    </div>
  );
}
