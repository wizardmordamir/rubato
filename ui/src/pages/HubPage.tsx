// A category hub landing page: a tile dashboard of the (enabled) pages in one
// group. One generic component drives all hubs (Data / Automation / Results /
// Security / Docs) — App.tsx routes each hub path to `<HubPage hubKey=… />`. Tiles
// come from the shared registry, shaped into a cwip `NavDomain` (the same model the
// SideNav derives, see navigationModel.ts); the drag/hide/recolor grid is the shared
// cwip/react `HubTileGrid`, backed by localStorage `useHubPrefs`.

import { type NavGroup, NAV_HUBS, pagesInGroup } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { HubTileGrid, type NavDomain, type NavItem, type NavTilePrefs } from "cursedbelt/react";
import { Link, useLocation } from "react-router-dom";
import { fetchUi } from "../api";
import { PageHeading } from "../components";
import { resolveNavIcon } from "../navigationModel";
import { useHubPrefs } from "../navPrefs";

export function HubPage({ hubKey }: { hubKey: Exclude<NavGroup, "top"> }) {
  const hub = NAV_HUBS.find((h) => h.key === hubKey);
  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });
  const enabled = ui?.pages ?? {};
  const { prefs, setHidden, setOrder, setColor } = useHubPrefs();
  const location = useLocation();

  if (!hub) return null;

  const items: NavItem[] = pagesInGroup(hubKey)
    .filter((p) => enabled[p.key])
    .map((p) => ({ id: p.key, path: p.path, label: p.label, icon: p.key, description: p.description }));

  // The cwip HubTileGrid renders from a domain's single group; mirror the hub-domain
  // shape navigationModel.buildRubatoNavModel produces (item id = page key, resolved
  // to a glyph by resolveNavIcon).
  const domain: NavDomain = {
    id: hub.key,
    label: hub.label,
    icon: `hub:${hub.key}`,
    path: hub.path,
    groups: [{ id: hub.key, label: hub.label, items }],
  };

  // Per-hub tile prefs (order/hide/color) keyed by item id, wired back to the
  // localStorage store. Colors are a shared id→hex map; replay only the changed ids.
  const tilePrefs: NavTilePrefs = {
    hidden: prefs.hidden[hubKey] ?? [],
    order: prefs.order[hubKey] ?? [],
    colors: prefs.colors,
  };
  const onPrefsChange = (next: NavTilePrefs) => {
    setHidden(hubKey, next.hidden ?? []);
    setOrder(hubKey, next.order ?? []);
    const prevColors = prefs.colors;
    const nextColors = next.colors ?? {};
    for (const id of new Set([...Object.keys(prevColors), ...Object.keys(nextColors)])) {
      if (prevColors[id] !== nextColors[id]) setColor(id, nextColors[id]);
    }
  };

  return (
    <div>
      <PageHeading title={hub.label} />
      <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">{hub.description}</p>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          No pages available here.
        </p>
      ) : (
        <HubTileGrid
          domain={domain}
          activeHref={location.pathname}
          linkComponent={Link}
          resolveIcon={resolveNavIcon}
          prefs={tilePrefs}
          onPrefsChange={onPrefsChange}
        />
      )}
    </div>
  );
}
