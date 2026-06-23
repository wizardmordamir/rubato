import { ConfirmDialog } from "cursedbelt/react";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

// App-wide confirmation dialog. cwip used to ship `createConfirmContext`, but the
// confirm primitive was reshaped (it now offers an imperative `confirm()` plus a
// render-tree `<ConfirmDialog>`). We keep ru's familiar `useConfirm()`/`ConfirmProvider`
// surface by wiring a tiny context around cwip's styled `<ConfirmDialog>`, so the ~30
// call sites stay `if (await confirm("Remove this?")) doIt();`. Mount <ConfirmProvider>
// once near the root. Backdrop / Escape / Cancel all resolve false.

export interface ConfirmOptions {
  prompt: string;
  flavorText?: string;
  confirmText?: string;
  cancelText?: string;
}

export type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

export const useConfirm = (): ConfirmFn => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((result: boolean) => void) | null>(null);

  const settle = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback<ConfirmFn>((opts) => {
    const normalized = typeof opts === "string" ? { prompt: opts } : opts;
    // If a dialog is somehow already open, decline it before opening the new one.
    resolverRef.current?.(false);
    setOptions(normalized);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={options !== null}
        title={options?.prompt ?? ""}
        message={options?.flavorText}
        confirmLabel={options?.confirmText}
        cancelLabel={options?.cancelText}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}
