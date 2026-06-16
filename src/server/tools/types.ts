/**
 * Server-side tool contract. A RepoTool pairs a wire-level {@link ToolSpec}
 * (shown to the model, validated against) with a `run` that does the actual I/O
 * against an app's files or APIs. Built-in tools are code; user-defined tools
 * (loaded from ~/.rubato/tools) produce the same shape.
 */

import type { ToolSpec } from '../../lib/ai/toolProtocol';
import type { AppConfig } from '../../lib/apps';
import type { AskSource } from '../../shared/types';

export interface ToolContext {
  /** Present for app-scoped tools; absent for the general filesystem tools (which
   *  are bound to a root directory at construction time). */
  app?: AppConfig;
}

export interface ToolResult {
  ok: boolean;
  /** Observation text shown to the model (and surfaced as the tool result in the UI). */
  content: string;
  /** Files/ranges this call surfaced, folded into the answer's citations. */
  sources?: AskSource[];
}

export interface RepoTool {
  spec: ToolSpec;
  run(ctx: ToolContext, params: Record<string, unknown>): Promise<ToolResult>;
}
