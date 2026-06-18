import { useCallback } from "react";
import { usePersistentJson } from "../persisted";

export interface Shortcut {
  id: string;
  url: string;
  label: string;
}

interface ShortcutsState {
  items: Shortcut[];
  collapsed: boolean;
}

const KEY = "rubato.shortcuts.v1";
const DEFAULT: ShortcutsState = { items: [], collapsed: false };

export function useShortcuts() {
  const [raw, set] = usePersistentJson<ShortcutsState>(KEY, DEFAULT);
  const state: ShortcutsState = {
    items: raw.items ?? [],
    collapsed: raw.collapsed ?? false,
  };

  const patch = useCallback(
    (next: Partial<ShortcutsState>) => set({ ...state, ...next }),
    [state, set],
  );

  const isPinned = (url: string) => state.items.some((s) => s.url === url);

  const pin = (url: string, label: string) => {
    if (isPinned(url)) return;
    const id = `sc-${Math.random().toString(36).slice(2, 10)}`;
    patch({ items: [...state.items, { id, url, label }] });
  };

  const unpin = (id: string) => patch({ items: state.items.filter((s) => s.id !== id) });

  const unpinByUrl = (url: string) => patch({ items: state.items.filter((s) => s.url !== url) });

  const rename = (id: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    patch({ items: state.items.map((s) => (s.id === id ? { ...s, label: trimmed } : s)) });
  };

  const reorder = (orderedIds: string[]) => {
    const byId = new Map(state.items.map((s) => [s.id, s]));
    const next = orderedIds.map((id) => byId.get(id)).filter((s): s is Shortcut => Boolean(s));
    for (const s of state.items) if (!orderedIds.includes(s.id)) next.push(s);
    patch({ items: next });
  };

  const setCollapsed = (v: boolean) => patch({ collapsed: v });

  return { ...state, isPinned, pin, unpin, unpinByUrl, rename, reorder, setCollapsed };
}
