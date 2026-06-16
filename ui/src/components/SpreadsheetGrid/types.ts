import type { CellScalar, RevisionView } from "cwip/excel-engine/types";

export type CellEdit = { row: number; col: number; value: CellScalar };

export type SpreadsheetGridProps = {
  view: RevisionView;
  // Active sheet is controlled by the parent so it can refetch the sheet's data.
  onSheetChange: (sheet: string) => void;
  readOnly: boolean;
  // Fired on a committed cell edit (Enter / overlay close), only when editable.
  onCellEdit?: (edit: CellEdit) => void;
  className?: string;
};
