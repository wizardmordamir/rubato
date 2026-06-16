import { lazy, Suspense } from "react";
import type { GridTable } from "./table";

/**
 * The grid (react-table + react-virtual) is its own lazy chunk — it only
 * downloads when a user actually switches to the Grid view.
 */
const LazyGrid = lazy(() => import("./SpreadsheetGrid"));

export function SpreadsheetGrid(props: { table: GridTable; height?: number }) {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-gray-400">Loading grid…</div>}>
      <LazyGrid {...props} />
    </Suspense>
  );
}
