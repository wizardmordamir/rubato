// A category hub landing page: a tile dashboard of the (enabled) pages in one
// group. One generic component drives all hubs (Data / Automation / Results /
// Security / Docs) — App.tsx routes each hub path to `<HubPage hubKey=… />`. Tiles
// come from the shared registry; the drag/hide/recolor/"add section" grid is the
// shared cwip/react `HubTileGrid`, backed by localStorage `useHubPrefs`.

import { type NavGroup, NAV_HUBS, pagesInGroup } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import { type HubTile, HubTileGrid } from "cwip/react";
import { Link } from "react-router-dom";
import { fetchUi } from "../api";
import { PageHeading } from "../components";
import { PAGE_ICONS } from "../navMeta";
import { useHubPrefs } from "../navPrefs";

export function HubPage({ hubKey }: { hubKey: Exclude<NavGroup, "top"> }) {
  const hub = NAV_HUBS.find((h) => h.key === hubKey);
  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });
  const enabled = ui?.pages ?? {};
  const { prefs, setHidden, setOrder, setColor } = useHubPrefs();

  if (!hub) return null;

  const tiles: HubTile[] = pagesInGroup(hubKey)
    .filter((p) => enabled[p.key])
    .map((p) => ({ id: p.path, href: p.path, title: p.label, description: p.description ?? "", icon: PAGE_ICONS[p.key] }));

  return (
    <div>
      <PageHeading title={hub.label} />
      <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">{hub.description}</p>
      {tiles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          No pages available here.
        </p>
      ) : (
        <HubTileGrid
          tiles={tiles}
          hidden={prefs.hidden[hubKey] ?? []}
          order={prefs.order[hubKey] ?? []}
          colors={prefs.colors}
          onHiddenChange={(ids) => setHidden(hubKey, ids)}
          onOrderChange={(ids) => setOrder(hubKey, ids)}
          onColorChange={(id, color) => setColor(id, color)}
          linkComponent={Link}
        />
      )}
    </div>
  );
}
