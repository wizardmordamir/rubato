import { ConfirmDialog, createConfirmContext } from "cwip/react";

// App-wide confirmation dialog, fully shared with the sibling apps: cwip owns the
// imperative promise plumbing (createConfirmContext) and ships the styled dialog
// (ConfirmDialog, a compact ModalShell + Button surface that adopts our theme).
// Mount <ConfirmProvider> once near the root; useConfirm() returns an imperative
// confirm(opts) that resolves true/false, so call sites read like window.confirm:
//   if (await confirm("Remove this?")) doIt();
// Backdrop / Escape / Cancel all resolve false.
export const { ConfirmProvider, useConfirm, ConfirmButton, ConfirmIconButton } =
	createConfirmContext(ConfirmDialog);
