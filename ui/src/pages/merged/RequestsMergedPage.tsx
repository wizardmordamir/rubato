// Merged "Requests" page: the HTTP/curl request builder (the old /requests) and the
// catalogued REST service runner (the old /services) as tabs — both are ways to make
// an API call. The active tab lives in the URL (`?tab=`) so /services redirects in.

import { useSearchParams } from "react-router-dom";
import { Tabs } from "../../components";
import { RequestsPage } from "../RequestsPage";
import { ServicesPage } from "../ServicesPage";

const TABS = [
  { key: "builder", label: "Builder" },
  { key: "services", label: "Services" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function RequestsMergedPage() {
  const [params, setParams] = useSearchParams();
  const active: TabKey = params.get("tab") === "services" ? "services" : "builder";
  const setTab = (key: TabKey) => setParams(key === "builder" ? {} : { tab: key }, { replace: true });

  return (
    <div>
      <Tabs tabs={TABS} active={active} onChange={setTab} />
      {active === "builder" ? <RequestsPage /> : <ServicesPage />}
    </div>
  );
}
