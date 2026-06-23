// Builds cursedbelt's declarative NavigationModel (Domain → Group → Item) from
// rubato's shared page registry (`@shared/ui`: SIDEBAR / NAV_HUBS / UI_PAGES). The
// new cwip/react nav surfaces (SideNav, HeaderSearch, breadcrumbs, search catalogue)
// all derive from this single model instead of the old hand-passed `entries` arrays.
//
// Mapping: a top-level sidebar page → a domain with no groups (a plain rail row); a
// hub → a domain whose single group holds the hub's enabled pages (so they're
// reachable from the hub landing + universal search). A hub with exactly one enabled
// page collapses to a direct page domain (no needless hub landing), matching the
// previous sidebar behavior. Domain/item ids are the page/hub keys, so the existing
// localStorage nav prefs (order/hide/color, see `navPrefs`) key straight through.

import { NAV_HUBS, pageByKey, pagesInGroup, SIDEBAR } from "@shared/ui";
import {
  CURRENT_NAV_PREFS_VERSION,
  type IconResolver,
  type NavDomain,
  type NavigationModel,
  type NavItem,
  type NavPreferences,
} from "cursedbelt/react";
import { IconFileText } from "./icons";
import { HUB_ICONS, PAGE_ICONS } from "./navMeta";
import type { NavPrefs } from "./navPrefs";

/**
 * Resolve a model icon *name* to a node. The model stores names (strings) so it
 * stays React-free; this is the app's name → glyph map. Hub domains use a `hub:`
 * prefix to disambiguate from a same-keyed page (e.g. the `docs` page vs the Docs
 * hub); page/item names are the page key; `admin` is the owner-gated Admin row.
 */
export const resolveNavIcon: IconResolver = (name) => {
  if (!name) return null;
  if (name.startsWith("hub:")) return HUB_ICONS[name.slice(4)] ?? null;
  if (name === "admin") return <IconFileText />;
  return PAGE_ICONS[name] ?? null;
};

/** Build the navigation model for the currently-enabled pages (+ optional Admin). */
export function buildRubatoNavModel(enabled: Record<string, boolean>, adminOn: boolean): NavigationModel {
  const domains: NavDomain[] = [];
  for (const entry of SIDEBAR) {
    if (entry.kind === "page") {
      const p = pageByKey(entry.key);
      if (!p || !enabled[p.key]) continue;
      domains.push({ id: p.key, label: p.label, icon: p.key, path: p.path, groups: [] });
      continue;
    }
    // hub
    const hub = NAV_HUBS.find((h) => h.key === entry.key);
    if (!hub) continue;
    const hubPages = pagesInGroup(hub.key).filter((p) => enabled[p.key]);
    if (hubPages.length === 0) continue;
    if (hubPages.length === 1) {
      // Only one enabled page in this hub — link straight to it (skip the hub landing).
      const p = hubPages[0];
      domains.push({ id: p.key, label: p.label, icon: p.key, path: p.path, groups: [] });
      continue;
    }
    domains.push({
      id: hub.key,
      label: hub.label,
      icon: `hub:${hub.key}`,
      path: hub.path,
      groups: [
        {
          id: hub.key,
          label: hub.label,
          items: hubPages.map(
            (p): NavItem => ({ id: p.key, path: p.path, label: p.label, icon: p.key, description: p.description }),
          ),
        },
      ],
    });
  }
  // Admin is owner-gated (config `ui.admin`) — a normal, customizable rail row when on.
  if (adminOn) domains.push({ id: "/admin", label: "Admin", icon: "admin", path: "/admin", groups: [] });
  return { domains };
}

/** Adapt rubato's localStorage nav prefs to cwip's NavPreferences (domain-id keyed). */
export function toNavPreferences(prefs: NavPrefs): NavPreferences {
  return {
    version: CURRENT_NAV_PREFS_VERSION,
    order: prefs.order,
    hidden: prefs.hidden,
    colors: prefs.colors,
  };
}
