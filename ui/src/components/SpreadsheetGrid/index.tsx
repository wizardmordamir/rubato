import { lazy, Suspense } from "react";
import type { SpreadsheetGridProps } from "./types";

export type { CellEdit, SpreadsheetGridProps } from "./types";

// glide-data-grid + its CSS are heavy and canvas-based, so the grid is its own
// lazy chunk — it only downloads when a user actually opens a builder/revision.
const LazyGrid = lazy(() => import("./SpreadsheetGrid"));

export const SpreadsheetGrid = (props: SpreadsheetGridProps) => (
  <Suspense
    fallback={
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">Loading spreadsheet…</div>
    }
  >
    <LazyGrid {...props} />
  </Suspense>
);
