import { createContext, type ReactNode, useContext } from "react";
import { createToastStore, ToastList, type ToastVariant, useToasts } from "cwip/react";

// Toasts are backed by cwip's store-agnostic toast queue + view (createToastStore
// / useToasts / ToastList). The app keeps its tiny `useToast().notify(...)` API so
// call sites are unchanged; the queue, auto-expire, and rendering are shared.
type Kind = ToastVariant; // "info" | "success" | "warning" | "error"

const store = createToastStore({ defaultDurationMs: 4500 });
const notify = (message: string, kind: Kind = "info") => store.add(message, { variant: kind });

const ToastContext = createContext<{ notify: (message: string, kind?: Kind) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, dismiss } = useToasts(store);
  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <ToastList toasts={toasts} onDismiss={dismiss} position="top-right" />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
