// User customization of the sidebar + hub tiles, persisted in the browser (rubato
// is a single-user local app, so localStorage is the right home — no server round
// trip, instant paint). Mirrors cursedalchemy's `preferences.nav`/`preferences.hubs`
// but backed by `usePersistentJson` instead of Redux + the /settings endpoint.
//
// What lives here: per-entry accent color, show/hide, drag order, and the
// collapsed flag for the sidebar; per-hub hidden/order/color for the tiles. What
// does NOT live here: which pages are *enabled* — that's server config (`ui.pages`,
// see Settings → Pages), because it also gates the routes.

import { useCallback } from "react";
import { usePersistentJson } from "./persisted";

// ── Sidebar entries (top-level pages + hubs) ─────────────────────────────────

/** Per-entry sidebar customization. Ids are page keys or hub keys (see SIDEBAR). */
export interface NavPrefs {
  /** Start the desktop sidebar collapsed to an icon rail. */
  collapsed: boolean;
  /** Entry ids hidden from the sidebar. */
  hidden: string[];
  /** Entry id → accent hex (overrides the registry default). */
  colors: Record<string, string>;
  /** Entry ids in the user's chosen order; anything missing keeps its natural spot. */
  order: string[];
}

const NAV_KEY = "rubato.nav.v1";
const NAV_DEFAULT: NavPrefs = { collapsed: false, hidden: [], colors: {}, order: [] };

export function useNavPrefs() {
  const [raw, set] = usePersistentJson<NavPrefs>(NAV_KEY, NAV_DEFAULT);
  // Normalize so an older/partial stored shape never crashes a `.includes`/spread.
  const prefs: NavPrefs = {
    collapsed: raw.collapsed ?? false,
    hidden: raw.hidden ?? [],
    colors: raw.colors ?? {},
    order: raw.order ?? [],
  };

  const patch = useCallback((p: Partial<NavPrefs>) => set({ ...prefs, ...p }), [prefs, set]);

  const setCollapsed = useCallback((v: boolean) => patch({ collapsed: v }), [patch]);

  const setHidden = useCallback(
    (id: string, hidden: boolean) =>
      patch({ hidden: hidden ? [...prefs.hidden.filter((x) => x !== id), id] : prefs.hidden.filter((x) => x !== id) }),
    [patch, prefs.hidden],
  );

  const setColor = useCallback(
    (id: string, color: string | undefined) => {
      const colors = { ...prefs.colors };
      if (color) colors[id] = color;
      else delete colors[id];
      patch({ colors });
    },
    [patch, prefs.colors],
  );

  const setOrder = useCallback((order: string[]) => patch({ order }), [patch]);

  return { prefs, patch, setCollapsed, setHidden, setColor, setOrder };
}

// ── Hub tiles ────────────────────────────────────────────────────────────────

/** Per-hub tile customization (keyed by hub key; colors keyed by tile route path). */
export interface HubPrefs {
  /** hub key → hidden tile paths. */
  hidden: Record<string, string[]>;
  /** hub key → tile paths in user order. */
  order: Record<string, string[]>;
  /** tile path → accent hex. */
  colors: Record<string, string>;
}

const HUBS_KEY = "rubato.hubs.v1";
const HUBS_DEFAULT: HubPrefs = { hidden: {}, order: {}, colors: {} };

export function useHubPrefs() {
  const [raw, set] = usePersistentJson<HubPrefs>(HUBS_KEY, HUBS_DEFAULT);
  const prefs: HubPrefs = { hidden: raw.hidden ?? {}, order: raw.order ?? {}, colors: raw.colors ?? {} };

  const setHidden = useCallback(
    (hubKey: string, paths: string[]) => set({ ...prefs, hidden: { ...prefs.hidden, [hubKey]: paths } }),
    [prefs, set],
  );
  const setOrder = useCallback(
    (hubKey: string, paths: string[]) => set({ ...prefs, order: { ...prefs.order, [hubKey]: paths } }),
    [prefs, set],
  );
  const setColor = useCallback(
    (path: string, color: string | undefined) => {
      const colors = { ...prefs.colors };
      if (color) colors[path] = color;
      else delete colors[path];
      set({ ...prefs, colors });
    },
    [prefs, set],
  );

  return { prefs, setHidden, setOrder, setColor };
}
