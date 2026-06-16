/**
 * Wire types for the Plans page (AI remediation plans), shared between the server
 * route (src/server/plansRoutes.ts) and the UI. A plan is a stored Markdown document
 * (produced by the `ai-remediation-plan` pipeline script or written by hand) that the
 * user can view, edit, and export.
 */

export interface PlanInput {
  title: string;
  /** Optional app the plan is about. */
  app?: string | null;
  /** Where it came from (e.g. a pipeline run dir / "manual"). */
  source?: string | null;
  /** The Markdown body. */
  content: string;
}

export interface Plan extends PlanInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
