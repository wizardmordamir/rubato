/**
 * Automation environments — named sets of key-value variables that can be selected
 * when running an automation. Analogous to Postman environments: pick "Staging" and
 * all `${KEY}` references in the automation resolve from that environment's values.
 */

/** One variable row in an environment (same shape as the request-builder KV). */
export interface EnvVar {
  key: string;
  value: string;
  enabled: boolean;
}

/** A named set of variables for automation runs. */
export interface AutomationEnvironment {
  id: string;
  name: string;
  variables: EnvVar[];
  createdAt: number;
  updatedAt: number;
}

/** Collapse an environment's enabled variables into a plain `${KEY}` → value map. */
export function resolveEnvVars(variables: EnvVar[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of variables) {
    if (v.enabled && v.key.trim()) out[v.key.trim()] = v.value;
  }
  return out;
}
