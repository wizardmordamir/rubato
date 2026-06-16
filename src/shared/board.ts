/**
 * Wire types for the Board page — a simple Jira-like kanban for tracking work
 * tasks. Tasks move between fixed statuses (drag-drop in the UI); each carries
 * a title plus optional description/notes (markdown-ish text), links, and
 * uploaded images. No epics/stories — deliberately flat.
 */

export const BOARD_STATUSES = ['ready', 'in-progress', 'testing', 'complete'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export const BOARD_STATUS_LABELS: Record<BoardStatus, string> = {
  ready: 'Ready',
  'in-progress': 'In progress',
  testing: 'Testing',
  complete: 'Complete',
};

export interface BoardTaskInput {
  title: string;
  description?: string;
  notes?: string;
  /** Related URLs, shown as clickable links. */
  links: string[];
  /** Uploaded image URLs (served from /api/board/images/...). */
  images: string[];
  status: BoardStatus;
  /** Sort position within the status column (fractional inserts allowed). */
  position: number;
}

export interface BoardTask extends BoardTaskInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
