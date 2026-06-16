/**
 * Assemble the tools available for an app: built-in read-only repo tools plus
 * user-defined tools loaded from ~/.rubato/tools (scoped to the app). Built-ins
 * win on a name clash, so a user tool can't shadow `read_file` etc. The
 * orchestrator never needs to know where a tool came from.
 */

import { logger } from 'cwip';
import type { AppConfig } from '../../lib/apps';
import { loadConfig } from '../../lib/config';
import { BUILTIN_TOOLS } from './builtins';
import type { RepoTool } from './types';
import { loadUserTools } from './userTools';

export async function getToolsForApp(app: AppConfig): Promise<RepoTool[]> {
  const cfg = await loadConfig();
  const reserved = new Set(BUILTIN_TOOLS.map((t) => t.spec.name));
  const user = (await loadUserTools(app, cfg)).filter((t) => {
    if (reserved.has(t.spec.name)) {
      logger.warn(`[tools] user tool "${t.spec.name}" ignored — name reserved by a built-in`);
      return false;
    }
    return true;
  });
  return [...BUILTIN_TOOLS, ...user];
}
