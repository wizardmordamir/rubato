import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initUiScale } from "cursedbelt/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { BreadcrumbLabelProvider } from "./breadcrumbs";
import { ConfirmProvider } from "./confirm";
import { PromptProvider } from "./prompt";
import { ToastProvider } from "./toast";
import "./styles.css";

// Apply the saved app-wide UI size (vision-accessibility scale) before React
// mounts, so the chosen size shows with no flash. The control lives in
// Settings → Appearance (cwip/react <UiScaleControl/>).
initUiScale();

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <PromptProvider>
            <BrowserRouter>
              <BreadcrumbLabelProvider>
                <App />
              </BreadcrumbLabelProvider>
            </BrowserRouter>
          </PromptProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
