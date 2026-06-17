// UI-side nav metadata: maps the shared registry's page/hub keys to icons, and
// resolves a SidebarEntry into the bits the SideNav + Settings need (label, path,
// icon, default accent color). Icons live in the UI (not the pure-data `shared/ui`),
// so the mapping lives here.

import { NAV_HUBS, type NavGroup, type NavHub, pageByKey, pagesInGroup, SIDEBAR, type SidebarEntry } from "@shared/ui";
import type { NavSearchItem } from "cwip/react";
import type { ReactNode } from "react";
import {
  IconApps,
  IconBook,
  IconBug,
  IconChartBar,
  IconChat,
  IconClipboard,
  IconCode,
  IconColumns,
  IconDashboard,
  IconDatabase,
  IconExternal,
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconGlobe,
  IconLayers,
  IconList,
  IconPlay,
  IconSearch,
  IconShield,
  IconSliders,
  IconTable,
  IconTerminal,
  IconWrench,
  IconZap,
} from "./icons";

/** Page key → icon (used for top-level sidebar entries and hub tiles). */
export const PAGE_ICONS: Record<string, ReactNode> = {
  apps: <IconApps />,
  dashboard: <IconDashboard />,
  queries: <IconDatabase />,
  splunk: <IconSearch />,
  servicenow: <IconGlobe />,
  session: <IconLayers />,
  requests: <IconExternal />,
  commands: <IconTerminal />,
  scripts: <IconCode />,
  automations: <IconPlay />,
  pipelines: <IconGitBranch />,
  runs: <IconList />,
  files: <IconFolder />,
  vulnerabilities: <IconBug />,
  plans: <IconClipboard />,
  excel: <IconTable />,
  ask: <IconChat />,
  board: <IconColumns />,
  links: <IconExternal />,
  vault: <IconShield />,
  taskq: <IconClipboard />,
  "orchestration-processing": <IconChartBar />,
  tools: <IconWrench />,
  docs: <IconFileText />,
  "system-files": <IconTerminal />,
  "env-compare": <IconSliders />,
  config: <IconCode />,
};

/** Hub key → icon. */
export const HUB_ICONS: Record<string, ReactNode> = {
  data: <IconDatabase />,
  automation: <IconZap />,
  results: <IconFolder />,
  security: <IconShield />,
  docs: <IconBook />,
};

const HUB_BY_KEY: Record<string, NavHub> = Object.fromEntries(NAV_HUBS.map((h) => [h.key, h]));

/** What the SideNav + Settings render for one sidebar row. */
export interface ResolvedEntry {
  /** Stable id for prefs (page key or hub key). */
  id: string;
  kind: SidebarEntry["kind"];
  label: string;
  path: string;
  icon: ReactNode;
  /** Registry default accent (hex), before the user's `navPrefs.colors` override. */
  defaultColor?: string;
}

/** Resolve a SidebarEntry to its display info, or `null` if its key is unknown. */
export function resolveSidebarEntry(entry: SidebarEntry): ResolvedEntry | null {
  if (entry.kind === "hub") {
    const hub = HUB_BY_KEY[entry.key];
    if (!hub) return null;
    return { id: hub.key, kind: "hub", label: hub.label, path: hub.path, icon: HUB_ICONS[hub.key], defaultColor: hub.color };
  }
  const page = pageByKey(entry.key);
  if (!page) return null;
  return { id: page.key, kind: "page", label: page.label, path: page.path, icon: PAGE_ICONS[page.key], defaultColor: page.color };
}

/**
 * The flat catalogue the sidebar search box matches against: every enabled
 * top-level entry (pages + hub landing pages) PLUS every enabled hub child page
 * (grouped under its hub label), so typing "queries" or "excel" jumps straight to
 * a page nested inside a hub. `hidden` ids are flagged (still findable + shown
 * dimmed). Disabled pages are omitted (their routes don't exist).
 */
export function buildNavSearchItems(enabled: Record<string, boolean>, hidden: Set<string>): NavSearchItem[] {
  const items: NavSearchItem[] = [];
  // Top-level sidebar entries.
  for (const entry of SIDEBAR) {
    const r = resolveSidebarEntry(entry);
    if (!r) continue;
    if (r.kind === "page" && !enabled[r.id]) continue;
    if (r.kind === "hub" && !pagesInGroup(r.id as Exclude<NavGroup, "top">).some((p) => enabled[p.key])) continue;
    items.push({ id: r.id, label: r.label, href: r.path, icon: r.icon, hidden: hidden.has(r.id) });
  }
  // Hub child pages, grouped under their hub.
  for (const hub of NAV_HUBS) {
    for (const p of pagesInGroup(hub.key)) {
      if (!enabled[p.key]) continue;
      items.push({
        id: `child:${p.key}`,
        label: p.label,
        href: p.path,
        groupLabel: hub.label,
        icon: PAGE_ICONS[p.key],
        keywords: p.description ? [p.description] : undefined,
      });
    }
  }
  return items;
}
