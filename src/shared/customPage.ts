/**
 * Wire types for custom Pages — user-built dashboards. A page is a saved layout
 * (the shared cwip layout-engine model: a tree of widget nodes on a 12-col grid)
 * that the user designs by dragging widgets onto a canvas. Widgets are rubato's own
 * (board summary, app status, headings, …); the layout/grid/editor are the shared
 * `cwip/layout` + `cwip/react` engine.
 */

import type { LayoutView } from 'cwip/layout';

export interface CustomPageInput {
  title: string;
  /** Optional emoji/icon shown in the list + header. */
  icon?: string;
  description?: string;
  /** The designed layout (a single page surface): `{ enabled?, nodes[] }`. */
  layout: LayoutView;
}

export interface CustomPage extends CustomPageInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
