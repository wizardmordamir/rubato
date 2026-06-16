import { type ReactNode, useEffect } from "react";

/** A centered overlay dialog. Click the backdrop or press Esc to close. */
export function Modal({
  title,
  onClose,
  children,
  widthClass = "max-w-lg",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Tailwind max-width for the dialog. Defaults to a compact `max-w-lg`. */
  widthClass?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled above; backdrop click is a convenience.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 pt-[8vh]"
      onClick={onClose}
    >
      <div
        className={`w-full ${widthClass} rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <h3 className="font-mono text-sm font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 transition-colors hover:text-accent">
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
