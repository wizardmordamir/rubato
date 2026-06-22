import { UI_PAGES } from "@shared/ui";
import { DropIndicator, useDragReorder, useDragToMove } from "cursedbelt/react";
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Shortcut } from "../../hooks/useShortcuts";
import { useShortcuts } from "../../hooks/useShortcuts";
import { IconChevronDown, IconGrip, IconPin, IconPlus, IconX } from "../../icons";

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
  onRename,
  onUnpin,
}: {
  shortcut: Shortcut;
  /** Props from useDragReorder's getHandleProps — spread onto the grip button so
   *  only the grip has touchAction:none (mobile can still scroll/tap the link). */
  handleProps: { style: CSSProperties; onPointerDown: (e: ReactPointerEvent) => void };
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
      {/* Drag grip — only this element has touchAction:none so the link stays tappable and the list scrollable on mobile */}
      <button
        type="button"
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

  // Drag-to-reorder within the list.
  const { containerProps, getItemProps, getHandleProps } = useDragReorder({
    ids: items.map((s) => s.id),
    onReorder: reorder,
    axis: "y",
  });

  // Drag-to-move the entire panel anywhere on screen, persisted to localStorage.
  const {
    position: dockPos,
    containerRef: dockRef,
    dragHandleProps,
  } = useDragToMove("rubato.shortcuts-dock-position");

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
    <div
      ref={dockRef as React.RefObject<HTMLDivElement>}
      data-name="Shortcut-Dock"
      style={dockPos ? { position: "fixed", left: dockPos.left, top: dockPos.top } : undefined}
      className={`z-20 w-64 max-w-[calc(100vw-4rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-950/95${dockPos ? "" : " fixed bottom-4 right-36"}`}
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800">
        <div className="flex min-w-0 items-center gap-1">
          {/* Drag handle — grab to move the entire panel */}
          <button
            type="button"
            {...dragHandleProps}
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
      <nav {...containerProps} className="flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto p-2">
        {items.map((s) => {
          const { isDragging: _d, isOver: _o, insertBefore, insertAfter, style, ...handlers } = getItemProps(s.id);
          const handle = getHandleProps(s.id);
          return (
            <div
              key={s.id}
              {...handlers}
              style={style}
              className="relative"
            >
              {insertBefore && <DropIndicator orientation="horizontal" side="start" />}
              {insertAfter && <DropIndicator orientation="horizontal" side="end" />}
              <ShortcutChip
                shortcut={s}
                handleProps={handle}
                onRename={(label) => rename(s.id, label)}
                onUnpin={() => unpin(s.id)}
              />
            </div>
          );
        })}
      </nav>
    </div>
  );
}
