import type { ComponentType } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeading } from "../components";
import { CronTool } from "./tools/CronTool";
import { CurlTool } from "./tools/CurlTool";
import { JsonTool } from "./tools/JsonTool";
import { RegexTool } from "./tools/RegexTool";
import { YamlTool } from "./tools/YamlTool";

/**
 * Tools — client-side developer utilities (curl/fetch builder, JSON+CSV, regex,
 * cron, YAML). Each sub-tool's logic is a pure function in @shared/tools, so the
 * same code backs the library exports; nothing here hits the server.
 */
const TOOLS: Array<[string, string, ComponentType]> = [
  ["curl", "Curl / fetch", CurlTool],
  ["json", "JSON / CSV", JsonTool],
  ["regex", "Regex", RegexTool],
  ["cron", "Cron", CronTool],
  ["yaml", "YAML", YamlTool],
];

export function ToolsPage() {
  const [params, setParams] = useSearchParams();
  const active = params.get("t") ?? "curl";
  const Current = (TOOLS.find(([k]) => k === active) ?? TOOLS[0])[2];

  return (
    <div>
      <PageHeading title="Tools" />
      <div className="mb-4 flex flex-wrap gap-1 border-gray-200 border-b dark:border-gray-800">
        {TOOLS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setParams({ t: key })}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
              key === active
                ? "border-accent font-medium text-accent"
                : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <Current />
    </div>
  );
}
