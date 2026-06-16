import { getErrorMessage } from "cwip";
import { createApiHooks } from "cwip/react";
import { useToast } from "./toast";

// Rubato's TanStack-Query hooks, bound to cwip's createApiHooks. Rubato's transport
// is module-level (getJson/postJson + per-endpoint fns), so the client is unused —
// pass it as `null`; mutationFns ignore it. The factory owns the success-toast +
// invalidate + error-toast boilerplate that ~every page reimplemented by hand.
//
//   const archive = useApiMutation({
//     mutationFn: (_c, command: string) => archiveRun(command),
//     successToast: (_d, command) => `Archived "${command}"`,
//     invalidateKeys: [["archives"]],
//   });
//   archive.mutate(command);
export const { useApiQuery, useApiMutation } = createApiHooks<null>({
  useClient: () => null,
  useToaster: () => {
    const { notify } = useToast();
    return {
      success: (message) => notify(typeof message === "string" ? message : String(message ?? ""), "success"),
      error: (error) => notify(getErrorMessage(error), "error"),
    };
  },
});
