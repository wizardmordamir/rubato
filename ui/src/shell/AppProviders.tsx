// AppProviders — the non-router React context a friend mini-app needs around the
// imported rubato pages. The plugin pages (e.g. the Automations trio) use
// @tanstack/react-query, the toast queue, the confirm/prompt dialogs, and the
// breadcrumb-label registry; rubato's own main.tsx wires all of these by hand. A
// friend app gets them in one wrapper instead:
//
//   createRoot(el).render(
//     <StrictMode><AppProviders><App /></AppProviders></StrictMode>
//   );
//
// Router context is intentionally NOT included here — the app owns its own
// <BrowserRouter> (it decides the routes), and AppShell lives inside it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BreadcrumbLabelProvider } from "../breadcrumbs";
import { ConfirmProvider } from "../confirm";
import { PromptProvider } from "../prompt";
import { ToastProvider } from "../toast";

// A friend app rarely needs to touch the query client, so default to a shared one
// created on first import; callers that do (custom defaults, devtools) can inject
// their own via the `queryClient` prop.
const defaultQueryClient = new QueryClient();

export interface AppProvidersProps {
  children: ReactNode;
  /** Override the React Query client (defaults to a shared internal instance). */
  queryClient?: QueryClient;
}

export function AppProviders({ children, queryClient }: AppProvidersProps) {
  return (
    <QueryClientProvider client={queryClient ?? defaultQueryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <PromptProvider>
            <BreadcrumbLabelProvider>{children}</BreadcrumbLabelProvider>
          </PromptProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
