import type { ReactNode } from "react";
import { Toaster, toast } from "cursedbelt/react";

// Toasts are backed by cursedbelt's notification primitive (the sonner-based
// imperative `toast` API + a single `<Toaster />` mounted at the app root). The app
// keeps its tiny `useToast().notify(...)` API so call sites are unchanged; the queue,
// auto-expire, and rendering are shared. `notify` is a stable module-level function,
// so it's safe to use directly in effect/callback dependency arrays.
type Kind = "info" | "success" | "warning" | "error";

const notify = (message: string, kind: Kind = "info") => {
  if (kind === "success") toast.success(message);
  else if (kind === "error") toast.error(message);
  else if (kind === "warning") toast.warning(message);
  else toast.info(message);
};

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="top-right" />
    </>
  );
}

export function useToast() {
  return { notify };
}
