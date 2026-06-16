import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { fetchServices, runService, type ServiceRunResponse } from "../api";
import { Badge, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, OpenPathButton, PageHeading, Tooltip } from "../components";
import { ResultView } from "../result/ResultView";
import { tableFromUnknown } from "../result/table";
import { useToast } from "../toast";

/**
 * Services — a generic runner over the catalogued HTTP service clients
 * (Datadog, Dynatrace, GitHub, GitLab, Quay, Rancher, Harness). Pick a service +
 * operation, fill its params, and run; the raw JSON result is shown. The catalog
 * (and the `svc` CLI) come from the same server registry, so this stays in sync.
 */
export function ServicesPage() {
  const { notify } = useToast();
  const { data: services = [], isLoading } = useQuery({ queryKey: ["services"], queryFn: fetchServices });

  const [serviceName, setServiceName] = useState("");
  const [operationKey, setOperationKey] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ServiceRunResponse | null>(null);

  useEffect(() => {
    if (!serviceName && services.length) setServiceName(services[0].name);
  }, [services, serviceName]);

  const service = useMemo(() => services.find((s) => s.name === serviceName), [services, serviceName]);
  const operation = service?.operations.find((o) => o.key === operationKey);

  // Default/reset the operation when the service changes.
  useEffect(() => {
    setOperationKey(service?.operations[0]?.key ?? "");
  }, [service]);

  // Clear params + stale result whenever the chosen operation changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on operation switch
  useEffect(() => {
    setParams({});
    setResult(null);
  }, [operationKey]);

  const run = useMutation({
    mutationFn: () => runService({ service: serviceName, operation: operationKey, params }),
    onSuccess: (r) => {
      setResult(r);
      const n = Array.isArray(r.result) ? `${r.result.length} ${r.result.length === 1 ? "item" : "items"}` : "ok";
      notify(n, "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "run failed", "error"),
  });

  const missingRequired = (operation?.params ?? []).some((p) => p.required && !params[p.name]?.trim());
  const canRun = service?.configured && operation && !missingRequired;

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div>
      <PageHeading title="Services" count={services.length} />
      <p className="mb-4 text-xs text-gray-400">
        Call a configured service API and see the JSON. Same registry as the <code>svc</code> CLI. Add keys in{" "}
        <code>~/.rubato/.env</code>
        <OpenPathButton path="~/.rubato/.env" /> to enable a service.
      </p>

      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        {/* Service list */}
        <ul className="space-y-1">
          {services.map((s) => (
            <li key={s.name}>
              <button
                type="button"
                onClick={() => setServiceName(s.name)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                  s.name === serviceName
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                <Tooltip content={s.configured ? "configured" : "not configured"}>
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.configured ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"}`}
                  />
                </Tooltip>
                {s.label}
              </button>
            </li>
          ))}
        </ul>

        {/* Operation form */}
        {service && (
          <div className="space-y-4">
            {!service.configured && (
              <div className={`${CARD_CLASS} p-3 text-xs text-gray-500`}>
                <Badge tone="neutral">not configured</Badge> Set <code>{service.envHint}</code> in{" "}
                <code>~/.rubato/.env</code>
                <OpenPathButton path="~/.rubato/.env" /> to run {service.label}.
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Operation">
                <select
                  className={FIELD_CLASS}
                  value={operationKey}
                  onChange={(e) => setOperationKey(e.target.value)}
                >
                  {service.operations.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {operation && operation.params.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {operation.params.map((p) => (
                  <Field key={p.name} label={`${p.label}${p.required ? " *" : ""}`}>
                    <input
                      className={FIELD_CLASS}
                      value={params[p.name] ?? ""}
                      onChange={(e) => setParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                      placeholder={p.placeholder}
                    />
                  </Field>
                ))}
              </div>
            )}

            {(!service.configured || missingRequired) ? (
              <Tooltip content={!service.configured ? "service not configured" : "fill required params"}>
                <button
                  type="button"
                  onClick={() => run.mutate()}
                  disabled={!canRun || run.isPending}
                  className={BTN_PRIMARY_CLASS}
                >
                  {run.isPending ? "Running…" : "Run"}
                </button>
              </Tooltip>
            ) : (
              <button
                type="button"
                onClick={() => run.mutate()}
                disabled={!canRun || run.isPending}
                className={BTN_PRIMARY_CLASS}
              >
                {run.isPending ? "Running…" : "Run"}
              </button>
            )}

            {result && (
              <ResultView
                json={result.result}
                table={tableFromUnknown(result.result)}
                count={Array.isArray(result.result) ? result.result.length : undefined}
                filename={`${service.name}-${operationKey}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  );
}
