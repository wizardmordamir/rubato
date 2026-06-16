// Fetch the variables an automation references so the run dialog can build a
// preload form. Variables already set in ~/.rubato/.env come back `present` (the
// secret value is never sent); absent ones must be supplied before a run starts.

import { useQuery } from "@tanstack/react-query";
import { type AutomationVariable, fetchAutomationVariables } from "../api";

export interface AutomationVariablesState {
  variables: AutomationVariable[];
  /** Variables not resolvable from env — the form must collect these. */
  required: AutomationVariable[];
  loading: boolean;
}

export function useAutomationVariables(id: string | undefined): AutomationVariablesState {
  const { data, isLoading } = useQuery({
    queryKey: ["automation-variables", id],
    queryFn: () => fetchAutomationVariables(id as string),
    enabled: !!id,
    staleTime: 5_000,
  });
  const variables = data ?? [];
  return { variables, required: variables.filter((v) => !v.present), loading: isLoading };
}
