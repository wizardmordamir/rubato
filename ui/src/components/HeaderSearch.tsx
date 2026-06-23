import { useQuery } from "@tanstack/react-query";
import {
  allowAllGate,
  deriveSearchCatalogue,
  HeaderSearch as CwipHeaderSearch,
  type SearchResultGroup,
  useDebouncedValue,
} from "cursedbelt/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSearch, fetchUi } from "../api";
import { buildRubatoNavModel, resolveNavIcon } from "../navigationModel";
import { PAGE_ICONS } from "../navMeta";

// Group key → the page icon shown beside the group header. The chat group maps to
// the "ask" page's icon (its UI_PAGES key).
const groupIcon = (key: string) => PAGE_ICONS[key === "chat" ? "ask" : key];

/**
 * The global top-nav search: ONE box that finds both navigation pages (instant,
 * client-side over the derived nav catalogue — the same NavigationModel the sidebar
 * renders) AND content (commands, board tasks, tools, requests, queries, ServiceNow,
 * plans, excel automations, chat — the server `/api/search`, debounced). The shared
 * cwip <HeaderSearch> ranks the instant Pages layer from `catalogue` and renders the
 * debounced server `serverGroups` below it, with full keyboard navigation.
 */
export function HeaderSearch() {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 200);

  // Pages: instant, client-side over the derived catalogue (same model as the rail).
  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });
  const model = useMemo(() => buildRubatoNavModel(ui?.pages ?? {}, ui?.admin === true), [ui?.pages, ui?.admin]);
  const catalogue = useMemo(() => deriveSearchCatalogue(model, allowAllGate), [model]);

  // Content: server-side, debounced, once the query is meaningful (2+ chars).
  const { data } = useQuery({
    queryKey: ["contentSearch", debounced],
    queryFn: () => fetchSearch(debounced),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });
  const serverGroups = useMemo<SearchResultGroup[]>(
    () =>
      (data?.groups ?? []).map((g) => ({
        key: g.key,
        label: g.label,
        icon: groupIcon(g.key),
        items: g.items.map((h) => ({ id: h.id, path: h.href, label: h.title, sub: h.sub })),
      })),
    [data],
  );

  return (
    <CwipHeaderSearch
      catalogue={catalogue}
      serverGroups={serverGroups}
      onQueryChange={setQuery}
      placeholder="Search pages & content…"
      linkComponent={Link}
      onNavigate={() => setQuery("")}
      resolveIcon={resolveNavIcon}
      emptyContent={<p className="px-3 py-6 text-center text-sm text-gray-400">No matches</p>}
    />
  );
}
