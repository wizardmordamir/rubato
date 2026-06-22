import { UI_PAGES } from "@shared/ui";
import { FreeDragArea, useDragReorder, useDragToMove } from "cursedbelt/react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Shortcut } from "../../hooks/useShortcuts";
import { useShortcuts } from "../../hooks/useShortcuts";
import { IconChevronDown, IconGrip, IconPin, IconPlus, IconX } from "../../icons";

const DOCK_KEY = "rubato.shortcuts-dock-position";

// Free-move position for the desktop dock panel. The app owns persistence now (the
// drag primitive is controlled). Defaults to a bottom-right slot.
function loadDockPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
      if (typeof p?.left === "number" && typeof p?.top === "number") return { x: p.left, y: p.top };
    }
  } catch {}
  const w = typeof window !== "undefined" ? window.innerWidth : 1024;
  const h = typeof window !== "undefined" ? window.innerHeight : 768;
  return { x: Math.max(16, w - 304), y: Math.max(16, h - 360) };
}

function saveDockPos(p: { x: number; y: number }) {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(p));
  } catch {}
}

// Free-draggable, position-persisted wrapper for the dock panel. The header grip is
// wired via the render-prop's drag-handle props.
function MovableDock({
  className,
  children,
}: {
  className: string;
  children: (handleProps: Record<string, unknown>) => ReactNode;
}) {
  return (
    <FreeDragArea bounds="window">
      <MovableDockInner className={className}>{children}</MovableDockInner>
    </FreeDragArea>
  );
}

function MovableDockInner({
  className,
  children,
}: {
  className: string;
  children: (handleProps: Record<string, unknown>) => ReactNode;
}) {
  const [pos, setPos] = useState(loadDockPos);
  const { ref, style, dragHandleProps } = useDragToMove({
    itemId: "shortcuts-dock",
    position: pos,
    onMoved: (p) => {
      setPos(p);
      saveDockPos(p);
    },
    mode: "fixed",
  });
  return (
    <div ref={ref as Ref<HTMLDivElement>} data-name="Shortcut-Dock" style={style} className={className}>
      {children(dragHandleProps)}
    </div>
  );
}

// Resolve a page title from a pathname, or fall back to a cleaned-up path string.
function resolveLabel(url: string): string {
  const path = url.split("?")[0];
  const page = UI_PAGES.find((p) => p.path === path || (p.path !== "/" && path.startsWith(`${p.path}/`)));
  return (page?.label ?? path.replace(/^\//, "").replace(/-/g, " ")) || "Home";
}

// Inline label editor — shows on double-click, right-click, or long-press (touch).
function ShortcutChip({
  shortcut,
  handleProps,
  activatorRef,
  onRename,
  onUnpin,
}: {
  shortcut: Shortcut;
  /** Props from the drag hook's render-prop — spread onto the grip button so only
   *  the grip drags (mobile can still scroll/tap the link). */
  handleProps: Record<string, unknown>;
  /** dnd-kit's activator ref (so the keyboard sensor focuses the grip). */
  activatorRef?: Ref<HTMLButtonElement>;
  onRename: (label: string) => void;
  onUnpin: () => void;
}) {
  const { pathname, search } = useLocation();
  const isActive = shortcut.url === `${pathname}${search}`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shortcut.label);
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startEdit = () => {
    setDraft(shortcut.label);
    setEditing(true);
  };
  const commit = () => {
    if (draft.trim()) onRename(draft.trim());
    setEditing(false);
  };
  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label="Rename shortcut"
        className="w-full rounded-lg border border-accent bg-white px-3 py-1.5 text-sm text-gray-800 outline-none dark:bg-gray-900 dark:text-gray-100"
      />
    );
  }

  return (
    <div
      className={`flex w-full items-center rounded-lg border text-sm transition ${
        isActive
          ? "border-accent bg-accent-soft text-accent"
          : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-gray-600"
      }`}
    >
      {/* Drag grip — only this element drags so the link stays tappable and the list scrollable on mobile */}
      <button
        type="button"
        ref={activatorRef}
        {...handleProps}
        aria-label="Drag to reorder"
        title="Drag to reorder"
        className="flex shrink-0 items-center justify-center pl-2 pr-1 text-gray-300 hover:text-gray-500 pointer-coarse:min-h-[44px] pointer-coarse:px-2.5 dark:text-gray-600 dark:hover:text-gray-400"
      >
        <IconGrip size={12} />
      </button>
      <div className="min-w-0 flex-1">
        <Link
          to={shortcut.url}
          onContextMenu={(e) => {
            e.preventDefault();
            startEdit();
          }}
          onClick={(e) => {
            if (longPressRef.current) {
              e.preventDefault();
              longPressRef.current = false;
            }
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            startEdit();
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== "touch") return;
            longPressRef.current = false;
            timerRef.current = setTimeout(() => {
              longPressRef.current = true;
              startEdit();
            }, 500);
          }}
          onPointerUp={clearTimer}
          onPointerMove={clearTimer}
          onPointerCancel={clearTimer}
          title={`${shortcut.label} — double-click or right-click to rename`}
          className="flex min-w-0 w-full items-center gap-1.5 py-1.5 pl-1 pr-1 hover:cursor-pointer"
        >
          <span className="truncate">{shortcut.label}</span>
        </Link>
      </div>
      <button
        type="button"
        aria-label={`Unpin ${shortcut.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        className="flex shrink-0 items-center px-2 py-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

// The floating shortcuts panel — a drag-repositionable card of pinned page links.
// Renders nothing when there are no shortcuts. Desktop-only card; on mobile it shows
// as a bottom strip (hidden while the nav drawer is open, handled by AppShell).
export function ShortcutDock() {
  const { pathname, search } = useLocation();
  const { items, collapsed, isPinned, pin, unpin, rename, reorder, setCollapsed } = useShortcuts();

  // Drag-to-reorder within the list (full keyboard + touch via @dnd-kit).
  const {
    items: ordered,
    DragContext,
    Sortable,
  } = useDragReorder({
    items,
    getKey: (s) => s.id,
    onReorder: (next) => reorder(next.map((s) => s.id)),
    axis: "y",
    handle: true,
  });

  if (items.length === 0) return null;

  const currentUrl = `${pathname}${search}`;
  const currentLabel = resolveLabel(currentUrl);
  const alreadyPinned = isPinned(currentUrl);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label={`Show ${items.length} shortcut${items.length === 1 ? "" : "s"}`}
        title="Show shortcuts"
        className="fixed bottom-4 right-36 z-20 flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-2 text-accent shadow-lg hover:border-accent dark:border-gray-700 dark:bg-gray-900"
      >
        <IconPin size={14} />
        <span className="text-xs font-semibold">{items.length}</span>
      </button>
    );
  }

  return (
    <MovableDock className="z-20 w-64 max-w-[calc(100vw-4rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-950/95">
      {(moveProps) => (
        <>
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800">
            <div className="flex min-w-0 items-center gap-1">
              {/* Drag handle — grab to move the entire panel */}
              <button
                type="button"
                {...moveProps}
                aria-label="Drag to move shortcuts panel"
                title="Drag to move"
                className="flex items-center text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400"
              >
                <IconGrip size={14} />
              </button>
              <span className="text-xs font-medium uppercase tracking-wide text-gray-400">Shortcuts</span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {!alreadyPinned && (
                <button
                  type="button"
                  onClick={() => pin(currentUrl, currentLabel)}
                  aria-label="Pin this page"
                  title="Pin this page"
                  className="flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                >
                  <IconPlus size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                aria-label="Hide shortcuts"
                title="Hide shortcuts"
                className="flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                <IconChevronDown size={14} />
              </button>
            </div>
          </div>
          <DragContext>
            <nav className="flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto p-2">
              {ordered.map((s) => (
                <Sortable key={s.id} itemKey={s.id}>
                  {({ setNodeRef, setActivatorNodeRef, style, handleProps }) => (
                    <div ref={setNodeRef} style={style} className="relative">
                      <ShortcutChip
                        shortcut={s}
                        handleProps={handleProps}
                        activatorRef={setActivatorNodeRef}
                        onRename={(label) => rename(s.id, label)}
                        onUnpin={() => unpin(s.id)}
                      />
                    </div>
                  )}
                </Sortable>
              ))}
            </nav>
          </DragContext>
        </>
      )}
    </MovableDock>
  );
}
