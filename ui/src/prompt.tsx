import { Button, Input, ModalShell } from "cwip/react";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

// App-wide text-prompt dialog — the styled, app-native replacement for the
// browser's window.prompt(). Mirrors ./confirm (useConfirm): mount
// <PromptProvider> once near the root; usePrompt() returns an imperative
// prompt(opts) that resolves to the entered string, or null when
// cancelled/dismissed — so call sites read like window.prompt:
//   const name = await prompt("New environment name");
//   if (name) create(name);
// Backdrop / Escape / Cancel all resolve null. Built on cwip's ModalShell +
// Input + Button so it adopts the app theme.
//
// FOLLOW-UP: cwip already ships createConfirmContext + ConfirmDialog; the
// symmetric createPromptContext + PromptDialog should be promoted into cwip and
// shared with the sibling app once cwip is published (it's mid-upgrade now, so a
// new export would break a fresh registry install). Both apps currently keep this
// app-local copy.

export interface PromptOptions {
  prompt: string;
  flavorText?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

export type PromptFn = (opts: PromptOptions | string) => Promise<string | null>;

const PromptContext = createContext<PromptFn>(async () => null);

export const usePrompt = (): PromptFn => useContext(PromptContext);

export function PromptProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState("");
  const resolverRef = useRef<((result: string | null) => void) | null>(null);

  const settle = useCallback((result: string | null) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const prompt = useCallback<PromptFn>((opts) => {
    const normalized = typeof opts === "string" ? { prompt: opts } : opts;
    // If a dialog is somehow already open, decline it before opening the new one.
    resolverRef.current?.(null);
    setOptions(normalized);
    setValue(normalized.defaultValue ?? "");
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const { prompt: label, flavorText, placeholder, confirmText = "OK", cancelText = "Cancel" } = options ?? { prompt: "" };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {options && (
        <ModalShell size="sm" level="top" onClose={() => settle(null)} bodyClassName="p-6">
          <h2 className="text-center text-lg font-semibold">{label}</h2>
          {flavorText && <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">{flavorText}</p>}
          <Input
            // biome-ignore lint/a11y/noAutofocus: a prompt dialog should focus its field on open.
            autoFocus
            className="mt-4 w-full"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onEnter={() => settle(value)}
          />
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="default" onClick={() => settle(null)}>
              {cancelText}
            </Button>
            <Button variant="primary" onClick={() => settle(value)}>
              {confirmText}
            </Button>
          </div>
        </ModalShell>
      )}
    </PromptContext.Provider>
  );
}
