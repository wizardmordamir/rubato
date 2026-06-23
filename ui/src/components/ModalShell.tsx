import { Modal, type ModalSize } from "cursedbelt/react";
import type { ReactNode } from "react";

// Local compatibility shim for the old cwip `ModalShell`. The shared primitive was
// reshaped into `Modal` ({ open, onClose, size, title, children, footer }); this
// adapter preserves ru's familiar ModalShell call sites (subtitle, bodyClassName,
// always-mounted-means-open) so the dialogs render unchanged on the new API.
// `level`/`confirmOnClose` are accepted for source compatibility — `level` is a
// no-op (Modal owns its stacking) and confirm-on-close is a deliberate follow-up
// (closing no longer prompts; the parent still controls mount/unmount).
export interface ModalShellProps {
  size?: ModalSize;
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children?: ReactNode;
  bodyClassName?: string;
  /** Accepted for source compat with the old ModalShell; no longer wired. */
  level?: "base" | "top";
  confirmOnClose?: boolean;
  /** Defaults to true: ru mounts the dialog only while it should be open. */
  open?: boolean;
}

export function ModalShell({
  size = "md",
  title,
  subtitle,
  onClose,
  footer,
  children,
  bodyClassName,
  open = true,
}: ModalShellProps) {
  const heading =
    title != null && subtitle != null ? (
      <div className="flex flex-col gap-0.5">
        <span>{title}</span>
        <span className="text-sm font-normal text-gray-500 dark:text-gray-400">{subtitle}</span>
      </div>
    ) : (
      (title ?? undefined)
    );

  return (
    <Modal open={open} onClose={onClose} size={size} title={heading} footer={footer}>
      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
    </Modal>
  );
}
