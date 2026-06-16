import { useQuery } from "@tanstack/react-query";
import {
  filterNavSearch,
  HeaderSearch as ResponsiveSearch,
  type SearchResultGroup,
  SearchResults,
  useDebouncedValue,
} from "cwip/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSearch, fetchUi } from "../api";
import { IconLayers } from "../icons";
import { buildNavSearchItems, PAGE_ICONS } from "../navMeta";
import { useNavPrefs } from "../navPrefs";

// Group key → the page icon shown beside the group header. The chat group maps to
// the "ask" page's icon (its UI_PAGES key).
const groupIcon = (key: string) => PAGE_ICONS[key === "chat" ? "ask" : key];

/**
 * The global top-nav search: ONE box that finds both navigation pages (instant,
 * client-side over the same enabled sidebar catalogue) AND content (commands, board
 * tasks, tools, requests, queries, ServiceNow, plans, excel automations, chat — the
 * server `/api/search`, debounced). Hits render in a single grouped dropdown via the
 * shared cwip <SearchResults>; cwip's responsive <HeaderSearch> shell collapses to a
 * magnifying-glass icon on narrow phones (expanding to a full-width drop-down
 * overlay), so the page search now lives only here — the sidebar dropped its box.
 */
export function HeaderSearch() {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 200);

  // Pages: instant, client-side over the same enabled catalogue the sidebar uses.
  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });
  const { prefs } = useNavPrefs();
  const navItems = useMemo(
    () => buildNavSearchItems(ui?.pages ?? {}, new Set(prefs.hidden)),
    [ui?.pages, prefs.hidden],
  );
  const pageGroups = useMemo<SearchResultGroup[]>(() => {
    const matched = filterNavSearch(navItems, query).flatMap((g) => g.items);
    if (!matched.length) return [];
    return [
      {
        key: "pages",
        label: "Pages",
        icon: <IconLayers />,
        items: matched.map((it) => ({
          id: `page:${it.href}`,
          href: it.href,
          title: it.label,
          sub: it.groupLabel,
          icon: it.icon,
        })),
      },
    ];
  }, [navItems, query]);

  // Content: server-side, debounced, once the query is meaningful (2+ chars).
  const { data, isFetching } = useQuery({
    queryKey: ["contentSearch", debounced],
    queryFn: () => fetchSearch(debounced),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });
  const contentGroups: SearchResultGroup[] = (data?.groups ?? []).map((g) => ({
    key: g.key,
    label: g.label,
    icon: groupIcon(g.key),
    items: g.items,
  }));

  const groups = [...pageGroups, ...contentGroups];

  return (
    <ResponsiveSearch value={query} onChange={setQuery} placeholder="Search pages & content…" label="Search">
      {(close) => {
        const onNavigate = () => {
          setQuery("");
          close();
        };
        if (isFetching && groups.length === 0) {
          return <p className="px-3 py-6 text-center text-sm text-gray-400">Searching…</p>;
        }
        return (
          <SearchResults
            groups={groups}
            linkComponent={Link}
            onNavigate={onNavigate}
            emptyContent={<p className="px-3 py-6 text-center text-sm text-gray-400">No matches</p>}
          />
        );
      }}
    </ResponsiveSearch>
  );
}
